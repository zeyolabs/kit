import type { Handle } from '@sveltejs/kit/hooks';

import type { WorkerMiddleware } from '../../cloudflare/workers';
import type { EnvStore } from '../../utils/env';

import { runWithContext } from '../../cloudflare/context';
// Workers analog of rust-common's RequestMetrics/track_metrics — pushes rather than scrapes.
import { waitUntil } from '../../cloudflare/wait-until';
import { envStore } from '../../utils/env';
import { count, gauge, type IPrometheusClient, PrometheusClient } from './client';

/** Does nothing — the fallback `client()` returns when `PROMETHEUS_*` isn't configured in this
 *  env, so a caller expecting "swallow-and-log" fire-and-forget metrics (see `pushAndForget`'s own
 *  doc comment) doesn't get an unhandled construction throw instead. */
const NOOP_CLIENT: IPrometheusClient = {
	push: async () => {},
	pushAndForget: () => {},
	pushWithRetry: async () => {},
};

let instance: IPrometheusClient | null = null;

/** Isolate-level singleton, not per-request — the binding is isolate-stable. Private to this
 *  file: the generic middleware below has no `env` param to thread through, so it needs its own
 *  ambient access; a caller with an `env` in hand should construct `PrometheusClient` directly.
 *
 *  Construction itself (reading `PROMETHEUS_*` secrets/bindings) can throw when this env has none
 *  configured — local dev, most notably. Every caller here treats metrics as fire-and-forget, so
 *  that must degrade to a no-op instead of throwing: an unhandled construction error surfaces as
 *  an unhandled promise rejection in `pushRequestCount`'s async body, which crashes the whole
 *  process outside the real Workers runtime (Node kills on unhandled rejection by default). */
function client(): IPrometheusClient {
	if (instance) return instance;
	try {
		const env = envStore();
		return (instance = new PrometheusClient({
			password: env.secret('PROMETHEUS_PASSWORD'),
			user: env.string('PROMETHEUS_USER'),
			vpc: env.vpc('PROMETHEUS_VPC'),
		}));
	} catch (error) {
		console.warn('Prometheus metrics disabled — PROMETHEUS_* not configured in this env', {
			error: error instanceof Error ? error.message : String(error),
		});
		return (instance = NOOP_CLIENT);
	}
}

/** `colo` splits this metric per Cloudflare colo, so concurrent pushes from different colos don't race Prometheus's per-series ordering and get rejected as "out of order". */
async function pushRequestCount(
	service: string,
	method: string,
	route: string,
	status: number,
	colo?: string
): Promise<void> {
	client().pushAndForget(
		count('platform_http_requests_total', 1, {
			method,
			route,
			service,
			status: String(status),
			...(colo ? { colo } : {}),
		})
	);
}

export const Metrics = {
	/** Add to `sequence(...)` right after `contextHandle`. Falls back to fire-and-forget on apps
	 *  with no `Platform.ctx` (marketing, ui). */
	trackHTTP(service: string): Handle {
		return async ({ event, resolve }) => {
			const response = await resolve(event);
			const push = pushRequestCount(
				service,
				event.request.method,
				event.route.id ?? 'unmatched',
				response.status,
				(event.request as Request & { cf?: { colo?: string } }).cf?.colo
			);
			void waitUntil(push);
			return response;
		};
	},

	/** One call wires whichever surfaces a router has: HTTP request counts, `.queue(...)`
	 *  success/failure, and `.cron(...)` success/failure + last-run — `WorkerRouter.use()`/
	 *  `WorkerBindingRouter.use()` each apply only the fields that surface actually has.
	 */
	WorkerMiddleware<Env>(service: string): WorkerMiddleware<Env> {
		return {
			cron: async (cron, _env, _executionCtx, next) => {
				try {
					await next();
					client().pushAndForget(
						count('platform_cron_runs_total', 1, { cron, outcome: 'ok', service })
					);
					client().pushAndForget(
						gauge('platform_cron_last_run_timestamp_ms', Date.now(), { cron, service })
					);
				} catch (e) {
					client().pushAndForget(
						count('platform_cron_runs_total', 1, { cron, outcome: 'error', service })
					);
					throw e;
				}
			},
			http: async (c, next) => {
				const response = await next();
				const colo = (c.req.cf as undefined | { colo?: string })?.colo;
				c.executionCtx.waitUntil(
					pushRequestCount(service, c.req.method, c.route, response.status, colo)
				);
				return response;
			},
			queue: async (queueName, _env, _executionCtx, next) => {
				try {
					await next();
					client().pushAndForget(
						count('platform_queue_messages_total', 1, { outcome: 'ok', queue: queueName, service })
					);
				} catch (e) {
					client().pushAndForget(
						count('platform_queue_messages_total', 1, {
							outcome: 'error',
							queue: queueName,
							service,
						})
					);
					throw e;
				}
			},
		};
	},

	/** For a `TickingDurableObject.onTick()` implementation (`.../workers/ticking-do`) that wants
	 *  to push `platform_do_tick_runs_total`/`platform_do_tick_last_run_timestamp_ms`. */
	TickingDO(service: string, env: EnvStore): { onTick(outcome: 'error' | 'ok'): void } {
		const client = new PrometheusClient({
			password: env.secret('PROMETHEUS_PASSWORD'),
			user: env.string('PROMETHEUS_USER'),
			vpc: env.vpc('PROMETHEUS_VPC'),
		});
		return {
			onTick(outcome) {
				client.pushAndForget(count('platform_do_tick_runs_total', 1, { outcome, service }));
				if (outcome === 'ok') {
					client.pushAndForget(
						gauge('platform_do_tick_last_run_timestamp_ms', Date.now(), { service })
					);
				}
			},
		};
	},

	/** Plain-Worker `fetch` wrapper. `classifyRoute` collapses the path onto a fixed route set (no
	 *  router here to supply one, and an unbounded label would blow up cardinality). `secretNames`:
	 *  the app's secret-store binding names. */
	withHTTP<Env extends object>(
		service: string,
		classifyRoute: (path: string) => string,
		secretNames: ReadonlySet<string>,
		handler: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>
	): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
		return (request, env, ctx) =>
			runWithContext(env, secretNames, async () => {
				const response = await handler(request, env, ctx);
				ctx.waitUntil(
					pushRequestCount(
						service,
						request.method,
						classifyRoute(new URL(request.url).pathname),
						response.status,
						(request.cf as undefined | { colo?: string })?.colo
					)
				);
				return response;
			});
	},
};
