import { describe, expect, it, vi } from 'vitest';

import { SentryConfig } from './sentry';

const options = SentryConfig.options({
	dev: false,
	dsn: 'https://key@sentry.test/1',
	service: 'web',
});

describe('SentryConfig.options', () => {
	it('sends only outside dev, and only with a DSN', () => {
		expect(options.enabled).toBe(true);
		expect(options.environment).toBe('production');
		expect(SentryConfig.options({ dev: true, dsn: 'x' })).toMatchObject({
			enabled: false,
			environment: 'development',
		});
		expect(SentryConfig.options({ dev: false, dsn: undefined }).enabled).toBe(false);
	});

	it('drops events from a local run', () => {
		for (const url of ['http://localhost:5173/x', 'http://127.0.0.1/', 'http://[::1]:8787/']) {
			expect(options.beforeSend({ request: { url } })).toBeNull();
		}
		expect(options.beforeSend({ request: { url: 'https://app.workers.dev/' } })).not.toBeNull();
	});

	it('drops failures on the visitor side, but still reports an invalid sitekey', () => {
		const event = (value: string) => ({ exception: { values: [{ value }] } });
		for (const value of [
			'Load failed',
			'NetworkError when attempting to fetch resource.',
			'The network connection was lost.',
			'[Cloudflare Turnstile] Error: 600010.',
		]) {
			expect(options.beforeSend(event(value))).toBeNull();
		}
		for (const value of [
			'[Cloudflare Turnstile] Error: 400020.',
			'Cannot read properties of undefined',
		]) {
			expect(options.beforeSend(event(value))).not.toBeNull();
		}
	});

	it('with updated, drops any error once a newer deploy is live', async () => {
		const event = () => ({ exception: { values: [{ value: 'x is undefined' }] } });
		const send = (current: boolean, check: () => Promise<boolean>) =>
			SentryConfig.options({ dev: false, dsn: 'x', updated: { check, current } }).beforeSend(
				event()
			);
		const check = vi.fn(async () => true);
		expect(await send(true, check)).toBeNull();
		expect(check).not.toHaveBeenCalled();
		expect(await send(false, check)).toBeNull();
		expect(await send(false, async () => false)).toEqual(event());
		expect(await send(false, async () => Promise.reject(new Error('offline')))).toEqual(event());

		const stale = vi.fn(async () => true);
		const chunk = { exception: { values: [{ value: 'Failed to fetch' }] } };
		expect(
			SentryConfig.options({
				dev: false,
				dsn: 'x',
				updated: { check: stale, current: false },
			}).beforeSend(chunk)
		).toBeNull();
		expect(stale).toHaveBeenCalledOnce();
		for (const value of [
			'Failed to fetch dynamically imported module: /_app/x.js',
			'Unable to preload CSS for /_app/x.css',
		]) {
			expect(
				SentryConfig.options({
					dev: false,
					dsn: 'x',
					updated: { check: stale, current: false },
				}).beforeSend({ exception: { values: [{ value }] } })
			).toBeNull();
		}
		// The server passes no `updated`: a failed fetch there is a real error.
		expect(options.beforeSend(chunk)).toEqual(chunk);
	});

	it('scrubs personal data and tags the service', () => {
		const event = options.beforeSend({
			request: {
				cookies: 'session=1',
				data: '{"card":"4242"}',
				headers: {
					Authorization: 'Bearer t',
					'cf-access-jwt-assertion': 'jwt',
					'user-agent': 'ua',
				},
				query_string: 'token=secret',
				url: 'https://shop.test/login?token=secret#top',
			},
		});
		expect(event).toEqual({
			request: { headers: { 'user-agent': 'ua' }, url: 'https://shop.test/login' },
			tags: { service: 'web' },
		});
	});
});

describe('SentryConfig.clientErrors', () => {
	const report = vi.fn();
	const handle = SentryConfig.clientErrors(report);
	const input = (kind: string, status: number) =>
		({ error: { status }, kind }) as unknown as Parameters<typeof handle>[0];

	it('reports unexpected errors and 5xx, not expected 4xx', () => {
		handle(input('unknown', 500));
		handle(input('error', 503));
		handle(input('error', 404));
		expect(report).toHaveBeenCalledTimes(2);
	});
});
