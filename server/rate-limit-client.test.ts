import { describe, expect, it, vi } from 'vitest';

import type { LoggerClient } from './logger';

import { RateLimitClient, type RateLimiterBinding } from './rate-limit-client';

const logger = { error: vi.fn() } as unknown as LoggerClient;
const config = () => ({ requests: 3, window: 60 });

function binding(respond: () => Promise<unknown>): RateLimiterBinding {
	return {
		get: () => ({ fetch: respond as never }),
		idFromName: (name) => name,
	};
}

const json = (body: unknown, status: number) => ({
	json: async () => body,
	ok: status >= 200 && status < 300,
	status,
});

describe('RateLimitClient.check', () => {
	it('allows when the limiter allows', async () => {
		const client = new RateLimitClient(
			binding(async () => json({ allowed: true, remaining: 2 }, 200)),
			logger,
			config
		);
		expect(await client.check('ip:1', 'x')).toMatchObject({ allowed: true, remaining: 2 });
	});

	it('denies on a 429, with retryAfter (not treated as unavailable)', async () => {
		const client = new RateLimitClient(
			binding(async () => json({ allowed: false, retryAfter: 42 }, 429)),
			logger,
			config
		);
		expect(await client.check('ip:1', 'x')).toEqual({ allowed: false, retryAfter: 42 });
	});

	it('fails open and flags unavailable when the binding is missing', async () => {
		const client = new RateLimitClient(undefined, logger, config);
		expect(await client.check('ip:1', 'x')).toEqual({ allowed: true, unavailable: true });
	});

	it('fails open and flags unavailable when the limiter errors', async () => {
		const client = new RateLimitClient(
			binding(async () => {
				throw new Error('boom');
			}),
			logger,
			config
		);
		expect(await client.check('ip:1', 'x')).toEqual({ allowed: true, unavailable: true });
	});

	it('sends the category config to the limiter', async () => {
		const fetch = vi.fn(async () => json({ allowed: true }, 200));
		const client = new RateLimitClient(binding(fetch), logger, config);
		await client.check('ip:1', 'x');
		const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body);
		expect(body).toEqual({ category: 'x', limit: 3, userId: 'ip:1', window: 60 });
	});
});
