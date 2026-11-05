import { DurableObject } from 'cloudflare:workers';

import type { ScheduledHandler } from './index';

import { EnvStore } from '../../utils/env';

/** Storage key marking a tick currently in flight — see `ensureAlarm()`'s doc comment for why. */
const TICK_IN_PROGRESS_KEY = 'tickInProgress';

/**
 * Base class for a Durable Object whose whole job is a self-rescheduling alarm loop. Resolves
 * `EnvStore` and always re-arms even if `tick()` throws, then calls `onTick(outcome)` — no
 * default, implement it directly or wrap with `withTicking(...)`.
 *
 * ```ts
 * export class MyThingDO extends TickingDurableObject<Env> {
 *   protected readonly tickIntervalMs = 60_000;
 *   protected readonly service = 'my-worker';
 *   protected readonly secretNames = SECRET_STORE_BINDING_NAMES; // the app's secret-store binding names
 *   protected async tick(): Promise<void> { ... }
 *   protected async onTick(outcome: 'error' | 'ok'): Promise<void> {
 *     Metrics.TickingDO(this.service, envStore()).onTick(outcome);
 *   }
 * }
 * ```
 *
 * Wire a cron backstop with `.cron(expr, ensureTickingDO<Env>(env => env.MY_DO_NAMESPACE))` below.
 */
export abstract class TickingDurableObject<Env> extends DurableObject<Env> {
	/** the app's secret-store binding names. */
	protected abstract readonly secretNames: ReadonlySet<string>;
	protected abstract readonly service: string;
	protected abstract readonly tickIntervalMs: number;

	async alarm(): Promise<void> {
		await EnvStore.resolve(this.env, this.secretNames);
		await this.ctx.storage.put(TICK_IN_PROGRESS_KEY, true);
		try {
			await this.tick();
			await this.onTick('ok');
		} catch (e) {
			await this.onTick('error');
			throw e;
		} finally {
			await this.ctx.storage.delete(TICK_IN_PROGRESS_KEY);
			await this.ctx.storage.setAlarm(Date.now() + this.tickIntervalMs);
		}
	}

	/** No-op if an alarm is already scheduled or a tick is running — `getAlarm() === null` alone
	 *  can't tell a healthy in-progress tick from a genuinely broken chain, since the slot is
	 *  empty for a normal tick's whole duration too. */
	async ensureAlarm(): Promise<void> {
		const [current, tickInProgress] = await Promise.all([
			this.ctx.storage.getAlarm(),
			this.ctx.storage.get<boolean>(TICK_IN_PROGRESS_KEY),
		]);
		if (current === null && !tickInProgress) {
			await this.ctx.storage.setAlarm(Date.now() + this.tickIntervalMs);
		}
	}

	protected abstract onTick(outcome: 'error' | 'ok'): Promise<void>;

	protected abstract tick(): Promise<void>;
}

/** Plug `onTick` in at the binding site instead of overriding it in a subclass — same spot
 *  `WorkerDOBinding.withSentry(...)` already wraps the class:
 *
 * ```ts
 * export const MyThing = WorkerDOBinding.withSentry(
 *   withTicking(MyThingDO, (outcome, instance) => sendToSlack(`${instance.service}: ${outcome}`))
 * );
 * ```
 */
export function withTicking<Env, T extends TickingDurableObject<Env>>(
	DOClass: new (state: DurableObjectState, env: Env) => T,
	onTick: (outcome: 'error' | 'ok', instance: T) => Promise<void> | void
): new (state: DurableObjectState, env: Env) => T {
	// Extending T directly leaves its abstract members "unimplemented" as far as TS is concerned.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	class Ticking extends (DOClass as unknown as new (state: DurableObjectState, env: Env) => any) {
		protected async onTick(outcome: 'error' | 'ok'): Promise<void> {
			await onTick(outcome, this as unknown as T);
		}
	}
	return Ticking as unknown as new (state: DurableObjectState, env: Env) => T;
}

/** For `.cron(expr, ensureTickingDO<Env>(env => env.MY_DO_NAMESPACE))` — no per-worker handler
 *  needed when the DO's own `ensureAlarm()` is the whole job. */
export function ensureTickingDO<Env, Id = unknown>(
	getNamespace: (env: Env) => {
		get(id: Id): { ensureAlarm(): Promise<void> };
		idFromName(name: string): Id;
	},
	name = 'global'
): ScheduledHandler<Env> {
	return async (_controller, env) => {
		const namespace = getNamespace(env);
		await namespace.get(namespace.idFromName(name)).ensureAlarm();
	};
}
