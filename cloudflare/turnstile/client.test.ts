import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnvStore } from '../../utils/env';
import { TurnstileClient } from './client';

async function client() {
	EnvStore.resetForTests();
	await EnvStore.resolve({ TURNSTILE_SECRET_KEY: 'real-secret', TURNSTILE_SITE_KEY: 'real-site' });
	return new TurnstileClient(EnvStore.current(), 'TURNSTILE_SECRET_KEY', 'TURNSTILE_SITE_KEY');
}

function siteverify(success: boolean) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success }));
}

const posted = (fetch: ReturnType<typeof siteverify>) =>
	Object.fromEntries(fetch.mock.calls[0]![1]!.body as URLSearchParams);

afterEach(() => vi.restoreAllMocks());

describe('TurnstileClient', () => {
	it('verifies a token with the named secret and the client address', async () => {
		const fetch = siteverify(true);
		expect(
			await (await client()).verify({ hostname: 'app.example.com', ip: '203.0.113.7', token: 't' })
		).toBe(true);
		expect(posted(fetch)).toEqual({
			remoteip: '203.0.113.7',
			response: 't',
			secret: 'real-secret',
		});
	});

	it('is false for an empty token without a request, and for a rejected one', async () => {
		const fetch = siteverify(false);
		const turnstile = await client();
		expect(await turnstile.verify({ hostname: 'a.com', ip: null, token: '' })).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
		expect(await turnstile.verify({ hostname: 'a.com', ip: null, token: 'bad' })).toBe(false);
	});

	it('uses the test keys on loopback hosts only', async () => {
		const fetch = siteverify(true);
		const turnstile = await client();
		await turnstile.verify({ hostname: 'localhost', ip: null, token: 't' });
		expect(posted(fetch).secret).toBe('1x0000000000000000000000000000000AA');
		expect(turnstile.siteKey('localhost')).toBe('1x00000000000000000000AA');
		expect(turnstile.siteKey('app.example.com')).toBe('real-site');
	});
});
