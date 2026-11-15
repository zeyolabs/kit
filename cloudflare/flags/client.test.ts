import { afterEach, describe, expect, it, vi } from 'vitest';

import { FlagsClient } from './client';
import { FlagsDevClient } from './dev';
import { FakeFlagsClient } from './testing';

afterEach(() => vi.restoreAllMocks());

describe('FlagsClient.getBoolean', () => {
	it('returns the binding value', async () => {
		const getBooleanValue = vi.fn(async () => true);
		const flags = new FlagsClient({ getBooleanValue });
		await expect(flags.getBoolean('on')).resolves.toBe(true);
		expect(getBooleanValue).toHaveBeenCalledWith('on', false);
	});

	it('passes the fallback to the binding', async () => {
		const getBooleanValue = vi.fn(async (_k: string, d: boolean) => d);
		const flags = new FlagsClient({ getBooleanValue });
		await expect(flags.getBoolean('x', true)).resolves.toBe(true);
		expect(getBooleanValue).toHaveBeenCalledWith('x', true);
	});

	it('defaults the fallback to false when the binding throws, and never throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const flags = new FlagsClient({
			getBooleanValue: async () => {
				throw new Error('flagship down');
			},
		});
		await expect(flags.getBoolean('risky')).resolves.toBe(false);
		expect(warn).toHaveBeenCalledOnce();
	});

	it('uses an explicit fallback when the binding throws', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const flags = new FlagsClient({
			getBooleanValue: async () => {
				throw 'nope';
			},
		});
		await expect(flags.getBoolean('x', true)).resolves.toBe(true);
	});
});

describe('FakeFlagsClient', () => {
	it('returns the fallback until set, then the set value', async () => {
		const flags = new FakeFlagsClient();
		await expect(flags.getBoolean('a')).resolves.toBe(false);
		await expect(flags.getBoolean('a', true)).resolves.toBe(true);
		flags.set('a', true);
		await expect(flags.getBoolean('a')).resolves.toBe(true);
		flags.set('a', false);
		await expect(flags.getBoolean('a', true)).resolves.toBe(false);
	});
});

describe('FlagsDevClient', () => {
	it('returns the fallback until set, then the set value', async () => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		const flags = new FlagsDevClient();
		await expect(flags.getBoolean('a')).resolves.toBe(false);
		flags.set('a', true);
		await expect(flags.getBoolean('a')).resolves.toBe(true);
	});
});
