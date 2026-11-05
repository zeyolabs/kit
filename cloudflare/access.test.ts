import { beforeEach, describe, expect, it } from 'vitest';

import { type AccessConfig, AccessError, resetAccessKeyCache, verifyAccessJwt } from './access';

const config: AccessConfig = { aud: 'aud-123', teamDomain: 'team.cloudflareaccess.com' };
const NOW = 1_800_000_000_000;

const b64url = (data: ArrayBuffer | string) => {
	const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
	return btoa(String.fromCharCode(...bytes))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replaceAll('=', '');
};

async function makeKey(kid = 'k1') {
	const pair = await crypto.subtle.generateKey(
		{
			hash: 'SHA-256',
			modulusLength: 2048,
			name: 'RSASSA-PKCS1-v1_5',
			publicExponent: new Uint8Array([1, 0, 1]),
		},
		true,
		['sign', 'verify']
	);
	const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid };
	return { jwk, privateKey: pair.privateKey };
}

async function sign(
	privateKey: CryptoKey,
	claims: Record<string, unknown>,
	header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }
) {
	const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	const signature = await crypto.subtle.sign(
		'RSASSA-PKCS1-v1_5',
		privateKey,
		new TextEncoder().encode(body)
	);
	return `${body}.${b64url(signature)}`;
}

const good = {
	aud: [config.aud],
	email: 'owner@example.com',
	exp: NOW / 1000 + 600,
	iss: `https://${config.teamDomain}`,
	sub: 'user-1',
};

describe('verifyAccessJwt', () => {
	beforeEach(() => resetAccessKeyCache());

	it('accepts a valid token and returns the identity', async () => {
		const { jwk, privateKey } = await makeKey();
		const token = await sign(privateKey, good);
		await expect(
			verifyAccessJwt(token, config, { loadKeys: async () => [jwk], now: NOW })
		).resolves.toEqual({
			email: 'owner@example.com',
			sub: 'user-1',
		});
	});

	it.each([
		['wrong audience', { aud: ['other'] }],
		['wrong issuer', { iss: 'https://evil.cloudflareaccess.com' }],
		['expired', { exp: NOW / 1000 - 1 }],
		['not yet valid', { nbf: NOW / 1000 + 60 }],
		['no email (service token)', { email: undefined }],
	])('rejects %s', async (_name, override) => {
		const { jwk, privateKey } = await makeKey();
		const token = await sign(privateKey, { ...good, ...override });
		await expect(
			verifyAccessJwt(token, config, { loadKeys: async () => [jwk], now: NOW })
		).rejects.toBeInstanceOf(AccessError);
	});

	it('rejects a token signed by a different key', async () => {
		const trusted = await makeKey();
		const attacker = await makeKey();
		const token = await sign(attacker.privateKey, good);
		await expect(
			verifyAccessJwt(token, config, { loadKeys: async () => [trusted.jwk], now: NOW })
		).rejects.toThrow('Bad signature');
	});

	it('rejects alg none and malformed tokens', async () => {
		const { jwk } = await makeKey();
		const loadKeys = async () => [jwk];
		const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64url(JSON.stringify(good))}.`;
		await expect(verifyAccessJwt(none, config, { loadKeys, now: NOW })).rejects.toBeInstanceOf(
			AccessError
		);
		await expect(
			verifyAccessJwt('not-a-jwt', config, { loadKeys, now: NOW })
		).rejects.toBeInstanceOf(AccessError);
		await expect(verifyAccessJwt('a.b.c', config, { loadKeys, now: NOW })).rejects.toBeInstanceOf(
			AccessError
		);
	});

	it('refetches signing keys once when the kid is unknown (key rotation)', async () => {
		const a = await makeKey('k1');
		const b = await makeKey('k2');
		let calls = 0;
		const loadKeys = async () => (++calls === 1 ? [a.jwk] : [a.jwk, b.jwk]);

		await verifyAccessJwt(await sign(a.privateKey, good), config, { loadKeys, now: NOW });
		expect(calls).toBe(1);
		// A second token with a cached key does not refetch.
		await verifyAccessJwt(await sign(a.privateKey, good), config, { loadKeys, now: NOW });
		expect(calls).toBe(1);
		// A token with a new kid triggers exactly one refetch.
		const rotated = await sign(b.privateKey, good, { alg: 'RS256', kid: 'k2' });
		await expect(verifyAccessJwt(rotated, config, { loadKeys, now: NOW })).resolves.toMatchObject({
			email: 'owner@example.com',
		});
		expect(calls).toBe(2);
	});
});
