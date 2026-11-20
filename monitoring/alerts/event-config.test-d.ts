import { expectTypeOf, test } from 'vitest';
import { z } from 'zod';

import type { EventConfigMap } from './event-config';
import type { EventRegistry } from './registry';

const EVENTS = {
	stock_low: { description: 'low', payload: z.object({ balance: z.number() }) },
} as const satisfies EventRegistry;

test("event configs only accept the registry's events and payload fields", () => {
	const base = { config: z.object({}), defaults: {}, summary: () => '' };

	const unknownEvent = {
		// @ts-expect-error -- 'stock_nope' is not an event key in EVENTS
		stock_nope: { ...base, matches: () => true },
	} as const satisfies EventConfigMap<typeof EVENTS>;

	const absentField = {
		stock_low: {
			...base,
			// @ts-expect-error -- 'reason' is not in the stock_low payload
			matches: (payload) => payload.reason === 'x',
		},
	} as const satisfies EventConfigMap<typeof EVENTS>;

	const absentEntityField = {
		stock_low: {
			...base,
			// @ts-expect-error -- 'reason' is not in the stock_low payload
			entity: (payload) => payload.reason,
			matches: () => true,
		},
	} as const satisfies EventConfigMap<typeof EVENTS>;

	const entityMustReturnString = {
		stock_low: {
			...base,
			// @ts-expect-error -- entity returns a string, not a number
			entity: (payload) => payload.balance,
			matches: () => true,
		},
	} as const satisfies EventConfigMap<typeof EVENTS>;

	expectTypeOf([
		unknownEvent,
		absentField,
		absentEntityField,
		entityMustReturnString,
	]).not.toBeAny();
});
