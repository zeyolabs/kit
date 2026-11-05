import type { RequestEvent } from '@sveltejs/kit';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EnvStore } from '../../utils/env';
import { Metrics } from './metrics';

/**
 * Regression cover for a local-dev crash: `apps/dashboard`'s `hooks.server.ts` wires
 * `Metrics.trackHTTP(...)` into every request, but `PROMETHEUS_PASSWORD` isn't configured in
 * local `.dev.vars`. The metrics client is meant to be fire-and-forget (see `pushAndForget`'s own
 * doc comment: "a Prometheus outage must never block the caller's own critical path"), but
 * construction itself used to throw synchronously, which — since nothing in local dev's
 * `event.platform.ctx` exists to catch the resulting rejected promise — surfaced as an unhandled
 * promise rejection that killed the whole `pnpm dev:dashboard` process, not just the one request.
 */

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
	EnvStore.resetForTests();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
	vi.restoreAllMocks();
});

describe('Metrics.trackHTTP', () => {
	// One test, not two: `client()`'s `instance` is an isolate-level (here, module-level) singleton
	// by design — splitting "doesn't throw" and "only warns once" across separate `it()`s would let
	// the first call's cached fallback silently satisfy the second test for the wrong reason.
	it('resolves the response instead of throwing when PROMETHEUS_* is unconfigured, and only warns once', async () => {
		await EnvStore.resolve({}, new Set()); // no PROMETHEUS_PASSWORD anywhere — client() would throw
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const handle = Metrics.trackHTTP('dashboard');
		const event = {
			platform: undefined, // local `vite dev` has no Workers `ctx` — matches the crash's real shape
			request: { method: 'GET' },
			route: { id: '/[accountTag]' },
		} as unknown as RequestEvent;
		const resolve = async () => new Response('ok', { status: 200 });

		const first = await handle({ event, resolve });
		expect(await first.text()).toBe('ok');
		await handle({ event, resolve }); // cached no-op client — must not throw or warn again

		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('Prometheus metrics disabled'),
			expect.anything()
		);
	});
});
