import { waitUntil } from '../cloudflare/wait-until';

// Shared shapes for the four layers every app is built from: libraries (static functions), clients
// (talk to the outside world), services (talk to the db) and managers (permission, service call,
// events). These are types and tiny helpers only: no base classes, so apps keep plain constructors.

/**
 * Who a service acts for. A service is built as `new XService(ctx, db)` and every query it runs is
 * scoped by `ctx.accountId`; `memberId` and `kind` identify the actor for audit and events.
 */
export type ServiceCtx<Kind extends string = string> = {
	accountId: number;
	kind: Kind;
	memberId: number;
};

/** What a service mutation returns: the result for the caller plus the events it caused. */
export type Mutation<T, E> = { events: E[]; result: T };

/** Builds a `Mutation`. `events` defaults to none. */
export function mutation<T, E>(result: T, events: E[] = []): Mutation<T, E> {
	return { events, result };
}

/**
 * Where a manager sends the events a service returned (a realtime hub, a queue, a log). `publish`
 * never blocks the caller and never throws: a failed publish must not fail the mutation that was
 * already committed.
 */
export type EventPublisher<E> = { publish(events: E[]): void };

/**
 * An `EventPublisher` that hands `send` the events in the background (`waitUntil` in the Workers
 * runtime, fire-and-forget elsewhere) and swallows its errors, passing them to `onError` if given.
 */
export function backgroundPublisher<E>(
	send: (events: E[]) => Promise<unknown>,
	onError?: (error: unknown) => void
): EventPublisher<E> {
	return {
		publish(events) {
			if (events.length === 0) return;
			const run = (async () => {
				try {
					await send(events);
				} catch (error) {
					onError?.(error);
				}
			})();
			void waitUntil(run);
		},
	};
}
