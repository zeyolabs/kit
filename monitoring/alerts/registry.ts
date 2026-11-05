import { z } from 'zod';

/** One event's metadata: what it means, and the zod schema for its payload. */
export type EventMeta<Payload extends z.ZodType = z.ZodType> = {
	description: string;
	payload: Payload;
};

/**
 * A flat registry of every valid event, keyed by event name. Callers declare one with
 * `as const satisfies EventRegistry` and derive everything else from it through the helpers below,
 * so the key union, the keys array and the runtime schema can't drift from the event list.
 */
export type EventRegistry = Record<string, EventMeta>;

export type EventKey<R extends EventRegistry> = Extract<keyof R, string>;

/**
 * One fired event: its key plus the payload that key requires, as a union discriminated on
 * `event`. A union rather than a per-key map because consumers need to accept "any event" as a
 * single type and narrow on `event`; a map pushes that narrowing onto every caller.
 */
export type Event<R extends EventRegistry> = {
	[K in EventKey<R>]: { event: K; payload: z.infer<R[K]['payload']> };
}[EventKey<R>];

export const eventKeys = <R extends EventRegistry>(registry: R) =>
	Object.keys(registry) as [EventKey<R>, ...EventKey<R>[]];

/**
 * A zod union over every event in `registry`, discriminated on `event`. `extra` adds fields to
 * every arm — the queue wire format needs an envelope field kit has no notion of.
 *
 * `discriminatedUnion` wants a non-empty tuple and `.map()` only ever produces a plain array, so
 * the cast is required rather than a shortcut: zod doesn't care about tuple-vs-array at runtime,
 * and the returned type is pinned by the caller's own annotation.
 */
export const eventSchema = <R extends EventRegistry>(registry: R, extra?: z.ZodRawShape) =>
	z.discriminatedUnion(
		'event',
		eventKeys(registry).map((key) =>
			z.object({ ...extra, event: z.literal(key), payload: registry[key].payload })
		) as never
	);
