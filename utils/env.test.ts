import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EnvStore } from './env';

const ORIGINAL_ENV = { ...process.env };
const SECRET_NAMES = new Set(['MONITOR_RL_BYPASS', 'TURNSTILE_SECRET_KEY']);

beforeEach(() => {
	EnvStore.resetForTests();
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('EnvStore.secret()', () => {
	it('resolves a Secrets Store binding ({ get() }) shape', async () => {
		await EnvStore.resolve(
			{ TURNSTILE_SECRET_KEY: { get: async () => 'store-secret' } },
			SECRET_NAMES
		);
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('store-secret');
	});

	it('resolves a plain string (.dev.vars/wrangler.jsonc vars)', async () => {
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: 'plain-secret' }, SECRET_NAMES);
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('plain-secret');
	});

	it('ignores a { get() } binding whose name is not in secretNames (Service/VPC bindings share the same Fetcher RPC shape)', async () => {
		process.env.SOME_SERVICE_BINDING = 'dot-env-value';
		await EnvStore.resolve(
			{ SOME_SERVICE_BINDING: { get: async () => 'should-never-be-called' } },
			SECRET_NAMES
		);
		// Not gated as a secret, so secret() falls straight to the raw (non-string) env value.
		expect(() => EnvStore.current().secret('SOME_SERVICE_BINDING')).toThrow(
			'SOME_SERVICE_BINDING" secret is not configured'
		);
	});

	it('falls back to process.env when .get() throws (unseeded local binding)', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve(
			{
				TURNSTILE_SECRET_KEY: {
					get: async () => {
						throw new Error('unseeded');
					},
				},
			},
			SECRET_NAMES
		);
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('falls back to process.env when .get() resolves to non-string garbage (an RPC stub falsely answering `get`)', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve(
			{ TURNSTILE_SECRET_KEY: { get: async () => ({ name: 'Fetcher' }) } },
			SECRET_NAMES
		);
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('falls back to process.env when .get() resolves to null', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: { get: async () => null } }, SECRET_NAMES);
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('throws when unresolved and no process.env fallback exists', async () => {
		delete process.env.TURNSTILE_SECRET_KEY;
		await EnvStore.resolve({}, SECRET_NAMES);
		expect(() => EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toThrow(
			'TURNSTILE_SECRET_KEY" secret is not configured'
		);
	});
});

describe('EnvStore.secretNull()', () => {
	it('returns null instead of throwing when unresolved', async () => {
		await EnvStore.resolve({}, SECRET_NAMES);
		expect(EnvStore.current().secretNull('MONITOR_RL_BYPASS')).toBeNull();
	});

	it('returns the resolved value when present', async () => {
		await EnvStore.resolve({ MONITOR_RL_BYPASS: 'bypass-token' }, SECRET_NAMES);
		expect(EnvStore.current().secretNull('MONITOR_RL_BYPASS')).toBe('bypass-token');
	});
});
