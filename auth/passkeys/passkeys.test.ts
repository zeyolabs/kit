import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';
import type { AuthUser } from '../sessions/sessions';

import { TestAuthenticator } from '../__fixtures__/authenticator';
import { createTestDb } from '../__fixtures__/db';
import { findOrCreateUser } from '../users';
import {
	deletePasskey,
	findPasskey,
	listPasskeys,
	newChallenge,
	PasskeyError,
	registrationOptions,
	type RelyingParty,
	savePasskey,
	verifyAuthentication,
	verifyRegistration,
} from './passkeys';

const rp: RelyingParty = {
	id: 'app.example.com',
	name: 'Example',
	origin: 'https://app.example.com',
};

let db: AuthDb;
let user: AuthUser;
let authenticator: TestAuthenticator;

beforeEach(async () => {
	db = await createTestDb();
	user = await findOrCreateUser(db, 'ada@example.com');
	authenticator = await TestAuthenticator.create();
});

async function registered() {
	const challenge = newChallenge();
	const credential = verifyRegistration(await authenticator.register(challenge, rp), challenge, rp);
	await savePasskey(db, user.id, 'Laptop', credential);
	return (await findPasskey(db, credential.id))!;
}

describe('registration', () => {
	it('stores a verified ES256 passkey', async () => {
		const stored = await registered();
		expect(stored).toMatchObject({
			algorithm: -7,
			id: authenticator.id,
			name: 'Laptop',
			userId: user.id,
		});
		expect(await listPasskeys(db, user.id)).toHaveLength(1);
	});

	it('rejects a different challenge, origin or RP', async () => {
		const challenge = newChallenge();
		const response = await authenticator.register(challenge, rp);
		expect(() => verifyRegistration(response, newChallenge(), rp)).toThrow(PasskeyError);
		expect(() =>
			verifyRegistration(response, challenge, { ...rp, origin: 'https://evil.example' })
		).toThrow('Origin mismatch');
		expect(() => verifyRegistration(response, challenge, { ...rp, id: 'example.org' })).toThrow(
			PasskeyError
		);
	});

	it('requires user verification', async () => {
		authenticator.flags = 0x01;
		const challenge = newChallenge();
		const response = await authenticator.register(challenge, rp);
		expect(() => verifyRegistration(response, challenge, rp)).toThrow('User not verified');
	});

	it('lists existing passkeys as excluded', () => {
		const options = registrationOptions(rp, user, newChallenge(), ['abc']);
		expect(options.excludeCredentials).toEqual([{ id: 'abc', type: 'public-key' }]);
		expect(options.authenticatorSelection.userVerification).toBe('required');
	});
});

describe('authentication', () => {
	it('verifies a real signature', async () => {
		const stored = await registered();
		const challenge = newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(verifyAuthentication(response, challenge, rp, stored)).toBe(0);
	});

	it('rejects a signature from another key', async () => {
		const stored = await registered();
		const other = await TestAuthenticator.create();
		const challenge = newChallenge();
		const response = await other.signIn(challenge, rp);
		expect(() => verifyAuthentication(response, challenge, rp, stored)).toThrow('Bad signature');
	});

	it('rejects a replayed challenge, wrong origin or wrong RP', async () => {
		const stored = await registered();
		const challenge = newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(() => verifyAuthentication(response, newChallenge(), rp, stored)).toThrow(
			'Challenge mismatch'
		);
		const phished = await authenticator.signIn(challenge, rp, { origin: 'https://evil.example' });
		expect(() => verifyAuthentication(phished, challenge, rp, stored)).toThrow('Origin mismatch');
		const otherRp = await authenticator.signIn(challenge, rp, { rpId: 'evil.example' });
		expect(() => verifyAuthentication(otherRp, challenge, rp, stored)).toThrow('Wrong RP id');
	});

	it('rejects a counter that does not move forward', async () => {
		const stored = await registered();
		authenticator.counter = 5;
		const challenge = newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(verifyAuthentication(response, challenge, rp, stored)).toBe(5);
		expect(() =>
			verifyAuthentication(response, challenge, rp, { ...stored, signCount: 5 })
		).toThrow('possible cloned key');
	});
});

describe('deletePasskey', () => {
	it("only deletes the user's own passkey", async () => {
		const stored = await registered();
		const other = await findOrCreateUser(db, 'eve@example.com');
		expect(await deletePasskey(db, other.id, stored.id)).toBe(false);
		expect(await deletePasskey(db, user.id, stored.id)).toBe(true);
		expect(await findPasskey(db, stored.id)).toBeNull();
	});
});
