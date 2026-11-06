import {
	decodePKIXECDSASignature,
	decodeSEC1PublicKey,
	ECDSAPublicKey,
	p256,
	verifyECDSASignature,
} from '@oslojs/crypto/ecdsa';
import {
	decodePKCS1RSAPublicKey,
	RSAPublicKey,
	sha256ObjectIdentifier,
	verifyRSASSAPKCS1v15Signature,
} from '@oslojs/crypto/rsa';
import { sha256 } from '@oslojs/crypto/sha2';
import { constantTimeEqual } from '@oslojs/crypto/subtle';
import { decodeBase64urlIgnorePadding, encodeBase64urlNoPadding } from '@oslojs/encoding';
import {
	ClientDataType,
	coseAlgorithmES256,
	coseAlgorithmRS256,
	coseEllipticCurveP256,
	COSEKeyType,
	createAssertionSignatureMessage,
	parseAttestationObject,
	parseAuthenticatorData,
	parseClientDataJSON,
} from '@oslojs/webauthn';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import type { AuthDb } from '../../config';
import type { AuthUser } from '../sessions';

import { passkeys } from '../../schema';

// WebAuthn passkeys, verified server-side with oslo (pure JS, runs on Workers). Only what a
// passkey sign-in needs: no attestation (we ask for `none` and never trust a vendor's chain),
// user verification required, ES256 and RS256 keys. Options and responses travel as the
// WebAuthn JSON forms, so the browser side is `PublicKeyCredential.parse*OptionsFromJSON` and
// `credential.toJSON()` (see `client.ts`).

const ALGORITHMS = [coseAlgorithmES256, coseAlgorithmRS256];

/** Adding a passkey needs a session signed in this recently, so a stolen session cookie can't
 *  quietly plant a lasting credential. */
const FRESH_SESSION_MS = 15 * 60 * 1000;

/** The relying party: where the ceremony runs. `id` is the hostname (`origin` without scheme). */
export type RelyingParty = { id: string; name: string; origin: string };

export class PasskeyError extends Error {
	override name = 'PasskeyError';
}

export const RegistrationResponse = z.object({
	id: z.string().min(1).max(1024),
	rawId: z.string().min(1).max(1024),
	response: z.object({
		attestationObject: z.string().min(1),
		clientDataJSON: z.string().min(1),
		transports: z.array(z.string().max(32)).max(8).optional(),
	}),
	type: z.literal('public-key'),
});
export type RegistrationResponse = z.infer<typeof RegistrationResponse>;

export const AuthenticationResponse = z.object({
	id: z.string().min(1).max(1024),
	rawId: z.string().min(1).max(1024),
	response: z.object({
		authenticatorData: z.string().min(1),
		clientDataJSON: z.string().min(1),
		signature: z.string().min(1),
		userHandle: z.string().nullish(),
	}),
	type: z.literal('public-key'),
});
export type AuthenticationResponse = z.infer<typeof AuthenticationResponse>;

/** A fresh challenge, base64url. The caller keeps it (a short-lived cookie) until the response. */
function newChallenge(): string {
	return encodeBase64urlNoPadding(crypto.getRandomValues(new Uint8Array(32)));
}

/** `PublicKeyCredentialCreationOptionsJSON` for adding a passkey to `user`. */
function registrationOptions(
	rp: RelyingParty,
	user: AuthUser,
	challenge: string,
	existingIds: string[]
) {
	return {
		attestation: 'none',
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
		challenge,
		excludeCredentials: existingIds.map((id) => ({ id, type: 'public-key' })),
		pubKeyCredParams: ALGORITHMS.map((alg) => ({ alg, type: 'public-key' })),
		rp: { id: rp.id, name: rp.name },
		timeout: 120_000,
		user: {
			displayName: user.email,
			id: encodeBase64urlNoPadding(new TextEncoder().encode(String(user.id))),
			name: user.email,
		},
	};
}

/** `PublicKeyCredentialRequestOptionsJSON` for a username-less (discoverable) sign-in. */
function authenticationOptions(rp: RelyingParty, challenge: string) {
	return {
		allowCredentials: [],
		challenge,
		rpId: rp.id,
		timeout: 120_000,
		userVerification: 'required',
	};
}

function decode(value: string, what: string): Uint8Array {
	try {
		return decodeBase64urlIgnorePadding(value);
	} catch {
		throw new PasskeyError(`Malformed ${what}`);
	}
}

function checkClientData(
	clientDataJSON: Uint8Array,
	type: ClientDataType,
	challenge: string,
	rp: RelyingParty
) {
	const clientData = parseClientDataJSON(clientDataJSON);
	if (clientData.type !== type) throw new PasskeyError('Wrong ceremony type');
	if (!constantTimeEqual(clientData.challenge, decode(challenge, 'challenge'))) {
		throw new PasskeyError('Challenge mismatch');
	}
	if (clientData.origin !== rp.origin) throw new PasskeyError('Origin mismatch');
	if (clientData.crossOrigin) throw new PasskeyError('Cross-origin ceremony');
}

/** Verifies a registration response and returns the credential to store. */
function verifyRegistration(response: RegistrationResponse, challenge: string, rp: RelyingParty) {
	checkClientData(
		decode(response.response.clientDataJSON, 'clientDataJSON'),
		ClientDataType.Create,
		challenge,
		rp
	);
	const { authenticatorData } = parseAttestationObject(
		decode(response.response.attestationObject, 'attestationObject')
	);
	if (!authenticatorData.verifyRelyingPartyIdHash(rp.id)) throw new PasskeyError('Wrong RP id');
	if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
		throw new PasskeyError('User not verified');
	}
	const credential = authenticatorData.credential;
	if (!credential) throw new PasskeyError('No credential');
	const id = encodeBase64urlNoPadding(credential.id);
	if (id !== response.rawId) throw new PasskeyError('Credential id mismatch');

	const key = credential.publicKey;
	const algorithm = key.algorithm();
	let publicKey: Uint8Array;
	if (algorithm === coseAlgorithmES256 && key.type() === COSEKeyType.EC2) {
		const ec2 = key.ec2();
		if (ec2.curve !== coseEllipticCurveP256) throw new PasskeyError('Unsupported curve');
		publicKey = new ECDSAPublicKey(p256, ec2.x, ec2.y).encodeSEC1Uncompressed();
	} else if (algorithm === coseAlgorithmRS256 && key.type() === COSEKeyType.RSA) {
		const rsa = key.rsa();
		publicKey = new RSAPublicKey(rsa.n, rsa.e).encodePKCS1();
	} else {
		throw new PasskeyError('Unsupported algorithm');
	}
	const transports = (response.response.transports ?? []).join(',');
	return { algorithm, id, publicKey, signCount: authenticatorData.signatureCounter, transports };
}

/** Verifies a sign-in response against the stored passkey; returns the new signature counter. */
function verifyAuthentication(
	response: AuthenticationResponse,
	challenge: string,
	rp: RelyingParty,
	stored: { algorithm: number; publicKey: Uint8Array; signCount: number }
): number {
	const clientDataJSON = decode(response.response.clientDataJSON, 'clientDataJSON');
	checkClientData(clientDataJSON, ClientDataType.Get, challenge, rp);
	const rawAuthenticatorData = decode(response.response.authenticatorData, 'authenticatorData');
	const authenticatorData = parseAuthenticatorData(rawAuthenticatorData);
	if (!authenticatorData.verifyRelyingPartyIdHash(rp.id)) throw new PasskeyError('Wrong RP id');
	if (!authenticatorData.userPresent || !authenticatorData.userVerified) {
		throw new PasskeyError('User not verified');
	}

	const hash = sha256(createAssertionSignatureMessage(rawAuthenticatorData, clientDataJSON));
	const signature = decode(response.response.signature, 'signature');
	let valid = false;
	try {
		if (stored.algorithm === coseAlgorithmES256) {
			const key = decodeSEC1PublicKey(p256, stored.publicKey);
			valid = verifyECDSASignature(key, hash, decodePKIXECDSASignature(signature));
		} else if (stored.algorithm === coseAlgorithmRS256) {
			const key = decodePKCS1RSAPublicKey(stored.publicKey);
			valid = verifyRSASSAPKCS1v15Signature(key, sha256ObjectIdentifier, hash, signature);
		}
	} catch {
		valid = false;
	}
	if (!valid) throw new PasskeyError('Bad signature');

	// Authenticators that count (security keys) must move forward; synced passkeys always send 0.
	const count = authenticatorData.signatureCounter;
	if ((count !== 0 || stored.signCount !== 0) && count <= stored.signCount) {
		throw new PasskeyError('Signature counter went backwards: possible cloned key');
	}
	return count;
}

async function listPasskeys(db: AuthDb, userId: number) {
	return db
		.select({
			createdAt: passkeys.createdAt,
			id: passkeys.id,
			lastUsedAt: passkeys.lastUsedAt,
			name: passkeys.name,
		})
		.from(passkeys)
		.where(eq(passkeys.userId, userId))
		.orderBy(passkeys.createdAt);
}

async function findPasskey(db: AuthDb, id: string) {
	const [row] = await db.select().from(passkeys).where(eq(passkeys.id, id)).limit(1);
	return row ?? null;
}

async function savePasskey(
	db: AuthDb,
	userId: number,
	name: string,
	credential: ReturnType<typeof verifyRegistration>,
	now = Date.now()
): Promise<void> {
	await db.insert(passkeys).values({ ...credential, createdAt: now, name, userId });
}

async function recordPasskeyUse(
	db: AuthDb,
	id: string,
	signCount: number,
	now = Date.now()
): Promise<void> {
	await db.update(passkeys).set({ lastUsedAt: now, signCount }).where(eq(passkeys.id, id));
}

/** Deletes one of `userId`'s passkeys; `false` if it isn't theirs. */
async function deletePasskey(db: AuthDb, userId: number, id: string): Promise<boolean> {
	const deleted = await db
		.delete(passkeys)
		.where(and(eq(passkeys.id, id), eq(passkeys.userId, userId)))
		.returning({ id: passkeys.id });
	return deleted.length > 0;
}

export const Passkeys = {
	authenticationOptions,
	delete: deletePasskey,
	find: findPasskey,
	FRESH_SESSION_MS,
	list: listPasskeys,
	newChallenge,
	recordUse: recordPasskeyUse,
	registrationOptions,
	save: savePasskey,
	verifyAuthentication,
	verifyRegistration,
};
