import { describe, expect, it } from 'vitest';

import { Crypto } from './crypto';

describe('Crypto.timingSafeEquals', () => {
	it('matches equal strings', () => {
		expect(Crypto.timingSafeEquals('abc', 'abc')).toBe(true);
		expect(Crypto.timingSafeEquals('', '')).toBe(true);
		expect(Crypto.timingSafeEquals('ünïcödé', 'ünïcödé')).toBe(true);
	});

	it('rejects unequal strings of the same length', () => {
		expect(Crypto.timingSafeEquals('abc', 'abd')).toBe(false);
		expect(Crypto.timingSafeEquals('abc', 'xbc')).toBe(false);
	});

	it('rejects strings of different lengths without throwing', () => {
		expect(Crypto.timingSafeEquals('abc', 'abcd')).toBe(false);
		expect(Crypto.timingSafeEquals('abcd', 'abc')).toBe(false);
		expect(Crypto.timingSafeEquals('', 'a')).toBe(false);
		expect(Crypto.timingSafeEquals('a', '')).toBe(false);
	});
});

describe('Crypto.getRandomSecret', () => {
	it('defaults to 32 bytes (64 hex chars)', () => {
		expect(Crypto.getRandomSecret()).toHaveLength(64);
	});

	it('respects an explicit byte length', () => {
		expect(Crypto.getRandomSecret(16)).toHaveLength(32);
	});

	it('is actually random', () => {
		expect(Crypto.getRandomSecret()).not.toBe(Crypto.getRandomSecret());
	});
});

describe('Crypto.hashSecret / verifySecret', () => {
	it('is deterministic', () => {
		expect(Crypto.hashSecret('a-secret')).toBe(Crypto.hashSecret('a-secret'));
	});

	it('differs for different inputs', () => {
		expect(Crypto.hashSecret('a-secret')).not.toBe(Crypto.hashSecret('another-secret'));
	});

	it('never equals the raw input', () => {
		expect(Crypto.hashSecret('a-secret')).not.toBe('a-secret');
	});

	it('verifySecret confirms a matching secret/hash pair', () => {
		const secret = 'a-secret';
		expect(Crypto.verifySecret(secret, Crypto.hashSecret(secret))).toBe(true);
	});

	it('verifySecret rejects a mismatched secret', () => {
		expect(Crypto.verifySecret('wrong-secret', Crypto.hashSecret('right-secret'))).toBe(false);
	});
});
