import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { EventRegistry } from './registry';

import { eventKeys, eventSchema } from './registry';

const REGISTRY = {
	order_paid: { description: 'paid', payload: z.object({ id: z.string() }) },
	order_shipped: {
		description: 'shipped',
		payload: z.object({ carrier: z.string(), id: z.string() }),
	},
	stock_low: { description: 'low', payload: z.object({ count: z.number() }) },
} as const satisfies EventRegistry;

describe('eventKeys', () => {
	it('lists every key in the registry', () => {
		expect(eventKeys(REGISTRY)).toEqual(['order_paid', 'order_shipped', 'stock_low']);
	});
});

describe('eventSchema', () => {
	const schema = eventSchema(REGISTRY);

	it('accepts a well-formed event for every key', () => {
		for (const [event, payload] of [
			['order_paid', { id: 'a' }],
			['order_shipped', { carrier: 'c', id: 'a' }],
			['stock_low', { count: 1 }],
		] as const) {
			expect(schema.safeParse({ event, payload }).success).toBe(true);
		}
	});

	it('rejects a payload belonging to a different key', () => {
		expect(schema.safeParse({ event: 'stock_low', payload: { id: 'a' } }).success).toBe(false);
	});

	it('rejects an unknown key', () => {
		expect(schema.safeParse({ event: 'order_nope', payload: {} }).success).toBe(false);
	});

	it('adds `extra` fields to every arm', () => {
		const withAccount = eventSchema(REGISTRY, { accountId: z.number() });
		expect(
			withAccount.safeParse({ accountId: 1, event: 'stock_low', payload: { count: 1 } }).success
		).toBe(true);
		expect(withAccount.safeParse({ event: 'stock_low', payload: { count: 1 } }).success).toBe(
			false
		);
	});
});
