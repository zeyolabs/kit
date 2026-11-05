import type { z } from 'zod';

import type { Event, EventKey, EventRegistry } from './registry';

/**
 * Optional behavior for one event: a user-configurable filter deciding whether a fired payload
 * actually trips an alert. An event with no entry in the map it belongs to always matches, with
 * no config to collect — this is only for an event that needs a real parameter, like
 * `credits_low`'s threshold.
 *
 * Distributed over `K` so the type is a union with one arm per event key. `matches` gets that
 * event's own payload type rather than a union of all payloads. `config` isn't correlated with
 * `matches`' second argument — a single object literal can't tie a schema to its own inferred
 * type — so `matches` and `summary` receive it as `unknown` and parse.
 */
export type EventConfig<
	R extends EventRegistry,
	K extends EventKey<R> = EventKey<R>,
> = K extends unknown
	? {
			config: z.ZodType;
			defaults: unknown;
			/** The entity this alert is about, for dedupe — absent means the whole payload is the entity. */
			entity?(payload: Extract<Event<R>, { event: K }>['payload']): string;
			matches(payload: Extract<Event<R>, { event: K }>['payload'], config: unknown): boolean;
			/** One-line description of the config, for list views. */
			summary(config: unknown): string;
		}
	: never;

export type EventConfigMap<R extends EventRegistry> = Partial<{
	[K in EventKey<R>]: EventConfig<R, K>;
}>;
