import { describe, expect, it } from 'vitest';

import { AppVite } from './app-config.js';

describe('AppVite.config', () => {
	it('builds the shared config with only the given differences', () => {
		const config = AppVite.config({
			packages: ['kit', 'shopping', 'ui'],
			port: 5174,
			sentryOrg: 'org',
			sentryProject: 'shop',
		});
		expect(config.server).toEqual({ port: 5174, strictPort: true });
		expect(config.optimizeDeps?.exclude).toEqual([
			'@zeyolabs/kit',
			'@zeyolabs/shopping',
			'@zeyolabs/ui',
		]);
		expect(config.test).toEqual({ include: ['src/**/*.test.ts'] });
		expect(config.resolve?.dedupe).toEqual(['@sveltejs/kit']);
		expect((config.plugins ?? []).length).toBeGreaterThan(3);
	});

	it('merges Turnstile and extra CSP sources into the shared base', () => {
		const csp = AppVite.csp({
			csp: { 'img-src': ['https://images.example.com'] },
			turnstile: true,
		});
		expect(csp['img-src']).toEqual(['self', 'data:', 'https://images.example.com']);
		expect(csp['script-src']).toEqual(['self', 'https://challenges.cloudflare.com']);
		expect(csp['frame-src']).toEqual(['https://challenges.cloudflare.com']);
		expect(AppVite.csp({})['frame-src']).toBeUndefined();
	});

	it('leaves out the test block when asked', () => {
		expect(
			AppVite.config({ port: 5190, sentryOrg: 'org', sentryProject: 'app', test: false }).test
		).toBeUndefined();
	});
});
