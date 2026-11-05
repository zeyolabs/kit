import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { EventConfigMap } from './event-config';
import type { EventRegistry } from './registry';

const EVENTS = {
	order_held: { description: 'held', payload: z.object({ reason: z.string() }) },
	stock_low: { description: 'low', payload: z.object({ balance: z.number() }) },
} as const satisfies EventRegistry;

const CONFIG = {
	order_held: {
		config: z.object({ reason: z.string() }),
		defaults: { reason: 'bounce_rate' },
		matches: (payload, config) => payload.reason === (config as { reason: string }).reason,
		summary: (config) => (config as { reason: string }).reason,
	},
	stock_low: {
		config: z.object({ threshold: z.number() }),
		defaults: { threshold: 100 },
		entity: () => 'stock',
		matches: (payload, config) => payload.balance < (config as { threshold: number }).threshold,
		summary: (config) => `Below ${(config as { threshold: number }).threshold}`,
	},
} as const satisfies EventConfigMap<typeof EVENTS>;

describe('event config', () => {
	it('is a plain partial map keyed by event, no entry required for every event', () => {
		const partial = { stock_low: CONFIG.stock_low } satisfies EventConfigMap<typeof EVENTS>;
		expect(partial.order_held).toBeUndefined();
	});

	it('scopes each entry’s matches to its own event payload', () => {
		expect(CONFIG.order_held.matches({ reason: 'bounce_rate' }, { reason: 'bounce_rate' })).toBe(
			true
		);
		expect(CONFIG.stock_low.matches({ balance: 50 }, { threshold: 100 })).toBe(true);
		expect(CONFIG.stock_low.matches({ balance: 150 }, { threshold: 100 })).toBe(false);
	});

	it('derives the dedupe entity and a summary from its own entry', () => {
		expect(CONFIG.stock_low.entity({ balance: 5 })).toBe('stock');
		expect(CONFIG.stock_low.summary({ threshold: 100 })).toBe('Below 100');
		expect('entity' in CONFIG.order_held).toBe(false);
	});
});
