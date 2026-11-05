// Cloudflare Access: verify the signed `Cf-Access-Jwt-Assertion` header an Access-protected
// Worker receives. Access already blocks unauthenticated requests at the edge; this is the
// defence in depth the docs ask for, so the app still fails closed if the Access policy is ever
// removed, or the Worker is reached some other way than through the protected hostname.
// https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/

export type AccessConfig = {
	/** The AUD tag of the Access application (a 64-char hex string, not a secret). */
	aud: string;
	/** e.g. `my-team.cloudflareaccess.com` */
	teamDomain: string;
};

export type AccessIdentity = { email: string; sub: string };

type Jwk = JsonWebKey & { kid?: string };

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';

const KEY_TTL_MS = 60 * 60 * 1000;
const keyCache = new Map<string, { fetchedAt: number; keys: Jwk[] }>();

export class AccessError extends Error {
	override name = 'AccessError';
}

function decodePart<T>(part: string): T {
	const base64 = part.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return JSON.parse(
		new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
	);
}

function decodeBytes(part: string): Uint8Array<ArrayBuffer> {
	const base64 = part.replaceAll('-', '+').replaceAll('_', '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function fetchAccessKeys(teamDomain: string): Promise<Jwk[]> {
	const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!response.ok)
		throw new AccessError(`Could not load Access signing keys (${response.status})`);
	const body = (await response.json()) as { keys?: Jwk[] };
	return body.keys ?? [];
}

async function keyFor(
	kid: string,
	teamDomain: string,
	loadKeys: (teamDomain: string) => Promise<Jwk[]>,
	now: number
): Promise<Jwk> {
	const cached = keyCache.get(teamDomain);
	const fresh = cached && now - cached.fetchedAt < KEY_TTL_MS;
	let keys = fresh ? cached.keys : undefined;
	let found = keys?.find((k) => k.kid === kid);
	if (!found) {
		// Unknown kid (or stale cache): Access rotates keys, so refetch once before giving up.
		keys = await loadKeys(teamDomain);
		keyCache.set(teamDomain, { fetchedAt: now, keys });
		found = keys.find((k) => k.kid === kid);
	}
	if (!found) throw new AccessError('Unknown signing key');
	return found;
}

/**
 * Verifies an Access JWT (RS256 signature, issuer, audience, expiry) and returns who it is for.
 * Throws `AccessError` for anything that is not a valid token for this application.
 * `loadKeys` and `now` exist for tests.
 */
export async function verifyAccessJwt(
	token: string,
	config: AccessConfig,
	{
		loadKeys = fetchAccessKeys,
		now = Date.now(),
	}: { loadKeys?: (teamDomain: string) => Promise<Jwk[]>; now?: number } = {}
): Promise<AccessIdentity> {
	const parts = token.split('.');
	if (parts.length !== 3) throw new AccessError('Malformed token');
	const [rawHeader, rawPayload, rawSignature] = parts;

	let header: { alg?: string; kid?: string };
	let payload: {
		aud?: string | string[];
		email?: string;
		exp?: number;
		iss?: string;
		nbf?: number;
		sub?: string;
	};
	try {
		header = decodePart(rawHeader);
		payload = decodePart(rawPayload);
	} catch {
		throw new AccessError('Malformed token');
	}
	if (header.alg !== 'RS256' || !header.kid) throw new AccessError('Unsupported token');

	const jwk = await keyFor(header.kid, config.teamDomain, loadKeys, now);
	const key = await crypto.subtle.importKey(
		'jwk',
		jwk,
		{ hash: 'SHA-256', name: 'RSASSA-PKCS1-v1_5' },
		false,
		['verify']
	);
	const valid = await crypto.subtle.verify(
		'RSASSA-PKCS1-v1_5',
		key,
		decodeBytes(rawSignature),
		new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
	);
	if (!valid) throw new AccessError('Bad signature');

	if (payload.iss !== `https://${config.teamDomain}`) throw new AccessError('Wrong issuer');
	const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!audiences.includes(config.aud)) throw new AccessError('Wrong audience');
	const seconds = Math.floor(now / 1000);
	if (typeof payload.exp !== 'number' || payload.exp <= seconds) throw new AccessError('Expired');
	if (typeof payload.nbf === 'number' && payload.nbf > seconds)
		throw new AccessError('Not yet valid');
	if (!payload.email || !payload.sub) throw new AccessError('Not a user token');

	return { email: payload.email, sub: payload.sub };
}

/** Test helper: forget cached signing keys. */
export function resetAccessKeyCache(): void {
	keyCache.clear();
}
