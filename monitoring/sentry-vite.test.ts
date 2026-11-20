import { describe, expect, it, vi } from 'vitest';

import { SentryVite } from './sentry-vite.js';

type Resolve = (id: string, importer?: string, options?: { ssr?: boolean }) => unknown;

function resolveWith(id: string, importer: string | undefined, ssr: boolean) {
	const plugin = SentryVite.bundleOpenTelemetry();
	const resolve = vi.fn(async (target: string) => ({ id: `/node_modules/${target}.js` }));
	const hook = plugin.resolveId as unknown as Resolve;
	return { resolve, result: hook.call({ resolve }, id, importer, { ssr }) };
}

describe('SentryVite.bundleOpenTelemetry', () => {
	it("resolves the server's @opentelemetry/api to Sentry's re-export, bundled", async () => {
		const { resolve, result } = resolveWith('@opentelemetry/api', '/app/kit/runtime.js', true);
		expect(await result).toEqual({ id: '/node_modules/@sentry/sveltekit/opentelemetry-api.js' });
		expect(resolve).toHaveBeenCalledWith(
			'@sentry/sveltekit/opentelemetry-api',
			'/app/kit/runtime.js',
			{
				skipSelf: true,
			}
		);
	});

	it('leaves the client build, other ids and the re-export file itself alone', () => {
		expect(resolveWith('@opentelemetry/api', '/app/x.js', false).result).toBeNull();
		expect(resolveWith('svelte', '/app/x.js', true).result).toBeNull();
		expect(
			resolveWith('@opentelemetry/api', '/n/@sentry/sveltekit/build/esm/opentelemetryApi.js', true)
				.result
		).toBeNull();
	});
});
