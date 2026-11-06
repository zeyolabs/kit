import { encodeBase64urlNoPadding } from '@oslojs/encoding';

import type {
	AuthenticationResponse,
	RegistrationResponse,
	RelyingParty,
} from '../sessions/passkeys/passkeys';

// A software ES256 authenticator: just enough CBOR, authenticator data and DER to drive the
// passkey ceremonies in tests with real WebCrypto signatures.

type Cbor = Cbor[] | number | string | Uint8Array | { entries: [Cbor, Cbor][] };

function head(major: number, value: number): number[] {
	if (value < 24) return [(major << 5) | value];
	if (value < 0x100) return [(major << 5) | 24, value];
	if (value < 0x10000) return [(major << 5) | 25, value >> 8, value & 0xff];
	return [
		(major << 5) | 26,
		(value >>> 24) & 0xff,
		(value >> 16) & 0xff,
		(value >> 8) & 0xff,
		value & 0xff,
	];
}

function cbor(value: Cbor): number[] {
	if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
	if (typeof value === 'string') {
		const bytes = new TextEncoder().encode(value);
		return [...head(3, bytes.length), ...bytes];
	}
	if (value instanceof Uint8Array) return [...head(2, value.length), ...value];
	if (Array.isArray(value)) return [...head(4, value.length), ...value.flatMap(cbor)];
	return [
		...head(5, value.entries.length),
		...value.entries.flatMap(([k, v]) => [...cbor(k), ...cbor(v)]),
	];
}

const concat = (...parts: (number[] | Uint8Array)[]) =>
	new Uint8Array(parts.flatMap((p) => [...p]));

/** IEEE P1363 `r||s` (what WebCrypto returns) to the DER form authenticators send. */
function toDer(signature: Uint8Array): Uint8Array {
	const int = (bytes: Uint8Array) => {
		let i = 0;
		while (i < bytes.length - 1 && bytes[i] === 0) i++;
		const trimmed = [...bytes.slice(i)];
		if (trimmed[0] & 0x80) trimmed.unshift(0);
		return [0x02, trimmed.length, ...trimmed];
	};
	const body = [...int(signature.slice(0, 32)), ...int(signature.slice(32))];
	return new Uint8Array([0x30, body.length, ...body]);
}

const b64 = (bytes: Uint8Array) => encodeBase64urlNoPadding(bytes);

export class TestAuthenticator {
	counter = 0;
	readonly credentialId = crypto.getRandomValues(new Uint8Array(16));
	flags = 0x01 | 0x04; // user present + verified
	get id() {
		return b64(this.credentialId);
	}

	private constructor(private readonly keys: CryptoKeyPair) {}

	static async create() {
		const keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		return new TestAuthenticator(keys);
	}

	/** Whether the public key's x or y coordinate starts with a zero byte. */
	async hasLeadingZeroCoordinate(): Promise<boolean> {
		const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.keys.publicKey));
		return raw[1] === 0 || raw[33] === 0;
	}

	async register(challenge: string, rp: RelyingParty): Promise<RegistrationResponse> {
		const raw = new Uint8Array(await crypto.subtle.exportKey('raw', this.keys.publicKey));
		const coseKey = cbor({
			entries: [
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, raw.slice(1, 33)],
				[-3, raw.slice(33, 65)],
			],
		});
		const authData = concat(
			await this.rpIdHash(rp.id),
			[this.flags | 0x40],
			this.counterBytes(),
			new Uint8Array(16),
			[0, this.credentialId.length],
			this.credentialId,
			coseKey
		);
		const attestationObject = new Uint8Array(
			cbor({
				entries: [
					['fmt', 'none'],
					['attStmt', { entries: [] }],
					['authData', authData],
				],
			})
		);
		return {
			id: this.id,
			rawId: this.id,
			response: {
				attestationObject: b64(attestationObject),
				clientDataJSON: b64(this.clientData('webauthn.create', challenge, rp.origin)),
				transports: ['internal'],
			},
			type: 'public-key',
		};
	}

	async signIn(
		challenge: string,
		rp: RelyingParty,
		overrides: { origin?: string; rpId?: string } = {}
	): Promise<AuthenticationResponse> {
		const authData = concat(
			await this.rpIdHash(overrides.rpId ?? rp.id),
			[this.flags],
			this.counterBytes()
		);
		const clientDataJSON = this.clientData(
			'webauthn.get',
			challenge,
			overrides.origin ?? rp.origin
		);
		const clientHash = new Uint8Array(await crypto.subtle.digest('SHA-256', clientDataJSON));
		const signature = new Uint8Array(
			await crypto.subtle.sign(
				{ hash: 'SHA-256', name: 'ECDSA' },
				this.keys.privateKey,
				concat(authData, clientHash)
			)
		);
		return {
			id: this.id,
			rawId: this.id,
			response: {
				authenticatorData: b64(authData),
				clientDataJSON: b64(clientDataJSON),
				signature: b64(toDer(signature)),
				userHandle: null,
			},
			type: 'public-key',
		};
	}

	private clientData(type: string, challenge: string, origin: string) {
		return new TextEncoder().encode(JSON.stringify({ challenge, origin, type }));
	}

	private counterBytes() {
		const c = this.counter;
		return [(c >>> 24) & 0xff, (c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
	}

	private async rpIdHash(rpId: string) {
		return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rpId)));
	}
}
