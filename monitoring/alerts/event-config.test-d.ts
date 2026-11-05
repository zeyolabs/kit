import { z } from 'zod';

import type { EventConfigMap } from './event-config';
import type { EventRegistry } from './registry';

const EVENTS = {
	stock_low: { description: 'low', payload: z.object({ balance: z.number() }) },
} as const satisfies EventRegistry;

const base = { config: z.object({}), defaults: {}, summary: () => '' };

export const unknownEvent = {
	// @ts-expect-error -- 'stock_nope' is not an event key in EVENTS
	stock_nope: { ...base, matches: () => true },
} as const satisfies EventConfigMap<typeof EVENTS>;

export const absentField = {
	stock_low: {
		...base,
		// @ts-expect-error -- 'reason' is not in the stock_low payload
		matches: (payload) => payload.reason === 'x',
	},
} as const satisfies EventConfigMap<typeof EVENTS>;

export const absentEntityField = {
	stock_low: {
		...base,
		// @ts-expect-error -- 'reason' is not in the stock_low payload
		entity: (payload) => payload.reason,
		matches: () => true,
	},
} as const satisfies EventConfigMap<typeof EVENTS>;

export const entityMustReturnString = {
	stock_low: {
		...base,
		// @ts-expect-error -- entity returns a string, not a number
		entity: (payload) => payload.balance,
		matches: () => true,
	},
} as const satisfies EventConfigMap<typeof EVENTS>;
