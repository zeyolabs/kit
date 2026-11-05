import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { LoggerClient } from '../logger/client';
import type { EventRegistry } from './registry';

import { Datetime } from '../../utils/datetime';
import { Schema } from '../../utils/schema';
import { Alert } from './client';

const REGISTRY = {
	order_held: {
		description: 'An order was held.',
		payload: z.object({ id: z.string(), reason: z.string() }),
	},
	trial_ending: {
		description: 'A trial is about to end.',
		payload: z.object({ endsAt: Schema.ZonedDateTimeWire }),
	},
} as const satisfies EventRegistry;

const EVENT = { event: 'order_held', payload: { id: 'abc-123', reason: 'manual' } } as const;

function fakeLogger(): LoggerClient {
	return { debug: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as LoggerClient;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('Alert.fire', () => {
	it('enqueues the event onto the queue binding', async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const logger = fakeLogger();
		const client = new Alert({ send }, logger, REGISTRY);

		await client.fire(7, EVENT.event, EVENT.payload);

		expect(send).toHaveBeenCalledWith({ ...EVENT, accountId: 7 });
		expect(logger.error).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('encodes the payload to its wire form before enqueueing', async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const client = new Alert({ send }, fakeLogger(), REGISTRY);

		await client.fire(7, 'trial_ending', { endsAt: Datetime.zonedFromUnixSeconds(1_763_337_600) });

		expect(send).toHaveBeenCalledWith({
			accountId: 7,
			event: 'trial_ending',
			payload: { endsAt: 1_763_337_600 },
		});
	});

	it('logs and throws without enqueueing when the payload is invalid', async () => {
		const send = vi.fn().mockResolvedValue(undefined);
		const logger = fakeLogger();
		const client = new Alert({ send }, logger, REGISTRY);

		await expect(client.fire(7, 'trial_ending', { endsAt: 'tomorrow' } as never)).rejects.toThrow();
		expect(send).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
	});

	it('logs and rethrows when the queue send rejects', async () => {
		const failure = new Error('queue full');
		const send = vi.fn().mockRejectedValue(failure);
		const logger = fakeLogger();
		const client = new Alert({ send }, logger, REGISTRY);

		await expect(client.fire(7, EVENT.event, EVENT.payload)).rejects.toThrow(failure);
		expect(logger.error).toHaveBeenCalledWith(
			failure,
			expect.objectContaining({ event: EVENT.event })
		);
	});

	it('warns and returns without throwing when the queue binding is absent', async () => {
		const logger = fakeLogger();
		const client = new Alert(undefined, logger, REGISTRY);

		await expect(client.fire(7, EVENT.event, EVENT.payload)).resolves.toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('alerts queue binding'),
			expect.objectContaining({ event: EVENT.event })
		);
		expect(logger.error).not.toHaveBeenCalled();
	});
});
