import { describe, expect, it, vi } from 'vitest';

import type { RateLimitClient, RateLimitResult } from './rate-limit-client';

import { RateLimit, type RateLimitEvent } from './rate-limit-guard';

function setup(
	result: RateLimitResult,
	{ ip = '1.2.3.4', skip = false, verifiedBot = false } = {}
) {
	const check = vi.fn(async () => result);
	const request = Object.assign(new Request('https://x.test'), { cf: { verifiedBot } });
	const event: RateLimitEvent = {
		getClientAddress: () => {
			if (!ip) throw new Error('no address');
			return ip;
		},
		request,
	};
	const guard = RateLimit.guard({
		client: () => ({ check }) as unknown as RateLimitClient,
		event: () => event,
		skip: () => skip,
	});
	return { check, guard };
}

describe('RateLimit.guard', () => {
	it('passes when allowed, keyed by ip and category', async () => {
		const { check, guard } = setup({ allowed: true });
		await guard('contact');
		expect(check).toHaveBeenCalledWith('ip:1.2.3.4', 'contact');
	});

	it('throws 429 with the wait when over the limit', async () => {
		const { guard } = setup({ allowed: false, retryAfter: 12 });
		await expect(guard()).rejects.toMatchObject({
			body: { message: 'Rate limit exceeded. Try again in 12s' },
			status: 429,
		});
	});

	it('fails open when unavailable, closed when asked', async () => {
		const { guard } = setup({ allowed: true, unavailable: true });
		await expect(guard()).resolves.toBeUndefined();
		await expect(guard('x', { failClosed: true })).rejects.toMatchObject({ status: 503 });
	});

	it('skips verified bots and skip()', async () => {
		const bot = setup({ allowed: false }, { verifiedBot: true });
		await bot.guard();
		expect(bot.check).not.toHaveBeenCalled();
		const skipped = setup({ allowed: false }, { skip: true });
		await skipped.guard();
		expect(skipped.check).not.toHaveBeenCalled();
	});

	it('uses "unknown" when the address cannot be resolved', async () => {
		const { check, guard } = setup({ allowed: true }, { ip: '' });
		await guard();
		expect(check).toHaveBeenCalledWith('ip:unknown', 'public:default');
	});
});
