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
