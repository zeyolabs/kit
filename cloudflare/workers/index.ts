// Minimal hand-rolled router + middleware chain for a plain Worker's fetch/queue/cron — no
// dependency, and queue/cron registration gets the same chaining shape fetch does.
//
// Two classes, not one: a Cloudflare Service Binding entrypoint (`WorkerEntrypoint`) is only ever
// reachable via RPC methods like `fetch()` — queues and Cron Triggers both bind to a worker's
// top-level default export, never to a named entrypoint class, so a binding can be neither a queue
// consumer nor scheduled. `WorkerBindingRouter` has no `.queue()`/`.cron()` at all, so that
// mismatch is a compile error instead of a handler that's registered but silently unreachable.
import type { CloudflareOptions } from '@sentry/cloudflare';
import type { DurableObject } from 'cloudflare:workers';

import * as Sentry from '@sentry/cloudflare';
import { WorkerEntrypoint } from 'cloudflare:workers';

import { runWithContext } from '../context';

type WorkerSentryEnv = { SENTRY_DSN: string; SENTRY_RELEASE?: string };
function sentryOptionsFor(env: WorkerSentryEnv): CloudflareOptions {
	return {
		dsn: env.SENTRY_DSN,
		environment: 'production',
		release: env.SENTRY_RELEASE,
		tracesSampleRate: 0,
	};
}

export type WorkerContext<Env> = {
	env: Env;
	executionCtx: ExecutionContext;
	json(data: unknown, status?: number): Response;
	req: Request;
	/** The matched route pattern (e.g. `/health`), or `"unmatched"` — for a metrics middleware's
	 *  label, so nothing needs its own path-collapsing allowlist. */
	route: string;
	/** Pre-parsed once per request — handlers that need query params/pathname read this instead of
	 *  re-parsing `req.url`. */
	url: URL;
};

export type CronMiddleware<Env> = (
	cronExpression: string,
	env: Env,
	executionCtx: ExecutionContext,
	next: () => Promise<void>
) => Promise<void>;
export type HttpHandler<Env> = (c: WorkerContext<Env>) => Promise<Response> | Response;
export type HttpMiddleware<Env> = (
	c: WorkerContext<Env>,
	next: () => Promise<Response>
) => Promise<Response>;
export type QueueHandler<Env> = (
	batch: MessageBatch<unknown>,
	env: Env,
	executionCtx: ExecutionContext
) => Promise<void>;
export type QueueMiddleware<Env> = (
	queueName: string,
	env: Env,
	executionCtx: ExecutionContext,
	next: () => Promise<void>
) => Promise<void>;
/** Return type is `unknown`, not `void` — the runtime ignores it either way (Cloudflare never
 *  reads a `scheduled()` return value), but this lets a handler double as a directly-testable
 *  function that returns something (a tally, a summary) without a separate void-returning wrapper
 *  just to satisfy this type. */
export type ScheduledHandler<Env> = (
	controller: ScheduledController,
	env: Env,
	executionCtx: ExecutionContext
) => Promise<unknown>;
/** What `.use()` takes on both router classes — one bundle instead of a separate call per surface
 *  (`.use(Metrics.WorkerMiddleware('inbox'))` wires HTTP, queue, and cron in one go). Each field is
 *  optional: `WorkerBindingRouter` only ever applies `http` (it has no queue/cron to wrap), and a
 *  bundle that only cares about one surface just omits the others. */
export type WorkerMiddleware<Env> = {
	cron?: CronMiddleware<Env>;
	http?: HttpMiddleware<Env>;
	queue?: QueueMiddleware<Env>;
};

type RawFetch<Env> = (
	request: Request,
	env: Env,
	executionCtx: ExecutionContext
) => Promise<Response>;

/** The route-match + middleware-chain dispatcher shared by both router classes below. Neither
 *  class exposes this directly — each wraps the result in Sentry differently (fetch alone for
 *  `WorkerBindingRouter`, fetch+queue together for `WorkerRouter`). */
function buildFetch<Env extends object>(
	routes: Map<string, HttpHandler<Env>>,
	middlewares: HttpMiddleware<Env>[],
	secretNames: ReadonlySet<string>
): RawFetch<Env> {
	return (request, env, executionCtx) =>
		runWithContext(env, secretNames, () => {
			const url = new URL(request.url);
			const handler = routes.get(`${request.method} ${url.pathname}`);
			const c: WorkerContext<Env> = {
				env,
				executionCtx,
				json: (data, status = 200) => Response.json(data, { status }),
				req: request,
				route: handler ? url.pathname : 'unmatched',
				url,
			};
			const run = () => Promise.resolve(handler ? handler(c) : new Response(null, { status: 404 }));
			const dispatch = (i: number): Promise<Response> =>
				i < middlewares.length ? middlewares[i](c, () => dispatch(i + 1)) : run();
			return dispatch(0);
		});
}

/** Fetch-only router for a Service Binding entrypoint — never public, only reachable by another
 *  worker holding a binding to it. No `.queue()`: see the file header for why. */
export class WorkerBindingRouter<Env extends object> {
	readonly fetch: RawFetch<Env>;
	private readonly middlewares: HttpMiddleware<Env>[] = [];
	private readonly routes = new Map<string, HttpHandler<Env>>();

	/** Prefer `WorkerBindingRouter.withSentry()` — this bare constructor skips Sentry
	 *  instrumentation entirely, which no real worker should ship without. */
	constructor(
		secretNames: ReadonlySet<string>,
		sentryOptions?: (env: Env) => CloudflareOptions | undefined
	) {
		const rawFetch = buildFetch(this.routes, this.middlewares, secretNames);
		this.fetch = sentryOptions
			? Sentry.withSentry(sentryOptions, { fetch: rawFetch }).fetch!
			: rawFetch;
	}

	/** `secretNames`: the app's secret-store binding names. */
	static withSentry<Env extends WorkerSentryEnv>(
		secretNames: ReadonlySet<string>
	): WorkerBindingRouter<Env> {
		return new WorkerBindingRouter<Env>(secretNames, sentryOptionsFor);
	}

	/** Terminal call — builds the `WorkerEntrypoint` class a `wrangler.jsonc` binding names via
	 *  `entrypoint: "..."`. */
	build(): new (ctx: ExecutionContext, env: Env) => WorkerEntrypoint<Env> {
		const fetch = this.fetch;
		return class extends WorkerEntrypoint<Env> {
			fetch(request: Request): Promise<Response> {
				return fetch(request, this.env, this.ctx);
			}
		};
	}

	get(path: string, handler: HttpHandler<Env>): this {
		this.routes.set(`GET ${path}`, handler);
		return this;
	}

	post(path: string, handler: HttpHandler<Env>): this {
		this.routes.set(`POST ${path}`, handler);
		return this;
	}

	/** Only `middleware.http` applies here — see `WorkerMiddleware`'s doc comment. */
	use(middleware: WorkerMiddleware<Env>): this {
		if (middleware.http) this.middlewares.push(middleware.http);
		return this;
	}
}

/** Router for a worker's top-level default export — fetch, queue, or both. Terminal `.build()`
 *  returns an `ExportedHandler`. For a Service Binding entrypoint, use `WorkerBindingRouter`
 *  instead — its `.build()` returns a `WorkerEntrypoint` class, not an `ExportedHandler`. */
export class WorkerRouter<Env extends object> {
	readonly fetch: RawFetch<Env>;
	readonly handleQueue: (
		batch: MessageBatch<unknown>,
		env: Env,
		executionCtx: ExecutionContext
	) => Promise<void>;
	readonly handleScheduled: (
		controller: ScheduledController,
		env: Env,
		executionCtx: ExecutionContext
	) => Promise<void>;
	private readonly cronHandlers = new Map<string, ScheduledHandler<Env>>();
	private readonly cronMiddlewares: CronMiddleware<Env>[] = [];
	private readonly middlewares: HttpMiddleware<Env>[] = [];
	private readonly queueHandlers = new Map<string, QueueHandler<Env>>();
	private readonly queueMiddlewares: QueueMiddleware<Env>[] = [];
	private readonly routes = new Map<string, HttpHandler<Env>>();

	/** Prefer `WorkerRouter.withSentry()` — this bare constructor skips Sentry instrumentation
	 *  entirely, which no real worker should ship without. */
	constructor(
		secretNames: ReadonlySet<string>,
		sentryOptions?: (env: Env) => CloudflareOptions | undefined
	) {
		const rawFetch = buildFetch(this.routes, this.middlewares, secretNames);
		const rawHandleQueue = (
			batch: MessageBatch<unknown>,
			env: Env,
			executionCtx: ExecutionContext
		): Promise<void> =>
			runWithContext(env, secretNames, () => {
				const handler = this.queueHandlers.get(batch.queue);
				if (!handler)
					throw new Error(`WorkerRouter: no queue handler registered for "${batch.queue}"`);
				const run = () => handler(batch, env, executionCtx);
				const dispatch = (i: number): Promise<void> =>
					i < this.queueMiddlewares.length
						? this.queueMiddlewares[i](batch.queue, env, executionCtx, () => dispatch(i + 1))
						: run();
				return dispatch(0);
			});
		const rawHandleScheduled = (
			controller: ScheduledController,
			env: Env,
			executionCtx: ExecutionContext
		): Promise<void> =>
			runWithContext(env, secretNames, () => {
				const handler = this.cronHandlers.get(controller.cron);
				if (!handler)
					throw new Error(`WorkerRouter: no cron handler registered for "${controller.cron}"`);
				// Discard the handler's return value here — Cloudflare's own `scheduled()` contract is
				// `Promise<void>`, but `ScheduledHandler` itself returns `unknown` so a handler can double
				// as a directly-testable function (see that type's doc comment).
				const run = async () => {
					await handler(controller, env, executionCtx);
				};
				const dispatch = (i: number): Promise<void> =>
					i < this.cronMiddlewares.length
						? this.cronMiddlewares[i](controller.cron, env, executionCtx, () => dispatch(i + 1))
						: run();
				return dispatch(0);
			});

		if (sentryOptions) {
			const wrapped = Sentry.withSentry(sentryOptions, {
				fetch: rawFetch,
				queue: rawHandleQueue,
				scheduled: rawHandleScheduled,
			});
			this.fetch = wrapped.fetch!;
			this.handleQueue = wrapped.queue!;
			this.handleScheduled = wrapped.scheduled!;
		} else {
			this.fetch = rawFetch;
			this.handleQueue = rawHandleQueue;
			this.handleScheduled = rawHandleScheduled;
		}
	}

	/** The one real entry point — every route/queue registration still chains off the returned
	 *  instance (`.use(...).post(...).queue(...)`), but `fetch`/`handleQueue` come out the other
	 *  end already Sentry-instrumented, same as every worker's export today, just without a
	 *  separate `Sentry.withSentry(...)` wrap at the bottom of the file. `secretNames`:
	 *  the app's secret-store binding names. */
	static withSentry<Env extends WorkerSentryEnv>(
		secretNames: ReadonlySet<string>
	): WorkerRouter<Env> {
		return new WorkerRouter<Env>(secretNames, sentryOptionsFor);
	}

	/** Terminal call for a worker's default export — fetch, queue, scheduled, or any mix. */
	build(): ExportedHandler<Env> {
		return { fetch: this.fetch, queue: this.handleQueue, scheduled: this.handleScheduled };
	}

	/** Registers a handler for one of `wrangler.jsonc`'s `triggers.crons` entries — dispatched by
	 *  `ScheduledController.cron` at runtime, same shape as `.queue(name, handler)`. `expression`
	 *  must match that config exactly, or this cron silently has no handler to run. */
	cron(expression: string, handler: ScheduledHandler<Env>): this {
		this.cronHandlers.set(expression, handler);
		return this;
	}

	get(path: string, handler: HttpHandler<Env>): this {
		this.routes.set(`GET ${path}`, handler);
		return this;
	}

	post(path: string, handler: HttpHandler<Env>): this {
		this.routes.set(`POST ${path}`, handler);
		return this;
	}

	queue(name: string, handler: QueueHandler<Env>): this {
		this.queueHandlers.set(name, handler);
		return this;
	}

	/** Applies whichever of `middleware.http`/`.queue`/`.cron` are present — see `WorkerMiddleware`'s
	 *  doc comment. One call wires every surface this router has at once. */
	use(middleware: WorkerMiddleware<Env>): this {
		if (middleware.http) this.middlewares.push(middleware.http);
		if (middleware.queue) this.queueMiddlewares.push(middleware.queue);
		if (middleware.cron) this.cronMiddlewares.push(middleware.cron);
		return this;
	}
}

export const WorkerDOBinding = {
	/** Same `.withSentry()` instrumentation as the router classes, for a Durable Object class. */
	withSentry<Env extends WorkerSentryEnv, T extends DurableObject<Env>>(
		DurableObjectClass: new (state: DurableObjectState, env: Env) => T
	): new (state: DurableObjectState, env: Env) => T {
		return Sentry.instrumentDurableObjectWithSentry<
			Env,
			T,
			new (state: DurableObjectState, env: Env) => T
		>(sentryOptionsFor, DurableObjectClass);
	},
};
