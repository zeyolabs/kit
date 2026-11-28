import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EnvStore } from './env';

const ORIGINAL_ENV = { ...process.env };
const SECRETS = { bypass: 'MONITOR_RL_BYPASS', turnstile: 'TURNSTILE_SECRET_KEY' };

beforeEach(() => {
	EnvStore.resetForTests();
	EnvStore.configure(SECRETS);
});

afterEach(() => {
	process.env = { ...ORIGINAL_ENV };
});

describe('EnvStore.secret()', () => {
	it('resolves a Secrets Store binding ({ get() }) shape', async () => {
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: { get: async () => 'store-secret' } });
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('store-secret');
	});

	it('resolves a plain string (.dev.vars/wrangler.jsonc vars)', async () => {
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: 'plain-secret' });
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('plain-secret');
	});

	it('ignores a { get() } binding whose name is not in secrets (Service/VPC bindings share the same Fetcher RPC shape)', async () => {
		process.env.SOME_SERVICE_BINDING = 'dot-env-value';
		await EnvStore.resolve({ SOME_SERVICE_BINDING: { get: async () => 'should-never-be-called' } });
		// Not gated as a secret, so secret() falls straight to the raw (non-string) env value.
		expect(() => EnvStore.current().secret('SOME_SERVICE_BINDING')).toThrow(
			'SOME_SERVICE_BINDING" secret is not configured'
		);
	});

	it('falls back to process.env when .get() throws (unseeded local binding)', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve({
			TURNSTILE_SECRET_KEY: {
				get: async () => {
					throw new Error('unseeded');
				},
			},
		});
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('falls back to process.env when .get() resolves to non-string garbage (an RPC stub falsely answering `get`)', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: { get: async () => ({ name: 'Fetcher' }) } });
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('falls back to process.env when .get() resolves to null', async () => {
		process.env.TURNSTILE_SECRET_KEY = 'dot-env-secret';
		await EnvStore.resolve({ TURNSTILE_SECRET_KEY: { get: async () => null } });
		expect(EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toBe('dot-env-secret');
	});

	it('throws when unresolved and no process.env fallback exists', async () => {
		delete process.env.TURNSTILE_SECRET_KEY;
		await EnvStore.resolve({});
		expect(() => EnvStore.current().secret('TURNSTILE_SECRET_KEY')).toThrow(
			'TURNSTILE_SECRET_KEY" secret is not configured'
		);
	});
});

describe('EnvStore.secretNull()', () => {
	it('returns null instead of throwing when unresolved', async () => {
		await EnvStore.resolve({});
		expect(EnvStore.current().secretNull('MONITOR_RL_BYPASS')).toBeNull();
	});

	it('returns the resolved value when present', async () => {
		await EnvStore.resolve({ MONITOR_RL_BYPASS: 'bypass-token' });
		expect(EnvStore.current().secretNull('MONITOR_RL_BYPASS')).toBe('bypass-token');
	});
});

describe('EnvStore.bindingNull()', () => {
	it('returns null instead of throwing when the binding is absent', () => {
		expect(new EnvStore({}).bindingNull('RATE_LIMITER')).toBeNull();
	});

	it('returns the binding when present', () => {
		const binding = { idFromName: () => 'id' };
		expect(new EnvStore({ RATE_LIMITER: binding }).bindingNull('RATE_LIMITER')).toBe(binding);
	});
});
