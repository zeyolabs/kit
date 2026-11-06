import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../../config';
import type { AuthUser } from '../sessions';

import { TestAuthenticator } from '../../__fixtures__/authenticator';
import { createTestDb } from '../../__fixtures__/db';
import { Users } from '../../users';
import { PasskeyError, type RelyingParty } from './passkeys';
import { Passkeys } from './passkeys';

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
	user = await Users.findOrCreate(db, 'ada@example.com');
	authenticator = await TestAuthenticator.create();
});

async function registered() {
	const challenge = Passkeys.newChallenge();
	const credential = Passkeys.verifyRegistration(
		await authenticator.register(challenge, rp),
		challenge,
		rp
	);
	await Passkeys.save(db, user.id, 'Laptop', credential);
	return (await Passkeys.find(db, credential.id))!;
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
		expect(await Passkeys.list(db, user.id)).toHaveLength(1);
	});

	it('rejects a different challenge, origin or RP', async () => {
		const challenge = Passkeys.newChallenge();
		const response = await authenticator.register(challenge, rp);
		expect(() => Passkeys.verifyRegistration(response, Passkeys.newChallenge(), rp)).toThrow(
			PasskeyError
		);
		expect(() =>
			Passkeys.verifyRegistration(response, challenge, { ...rp, origin: 'https://evil.example' })
		).toThrow('Origin mismatch');
		expect(() =>
			Passkeys.verifyRegistration(response, challenge, { ...rp, id: 'example.org' })
		).toThrow(PasskeyError);
	});

	it('requires user verification', async () => {
		authenticator.flags = 0x01;
		const challenge = Passkeys.newChallenge();
		const response = await authenticator.register(challenge, rp);
		expect(() => Passkeys.verifyRegistration(response, challenge, rp)).toThrow('User not verified');
	});

	it('lists existing passkeys as excluded', () => {
		const options = Passkeys.registrationOptions(rp, user, Passkeys.newChallenge(), ['abc']);
		expect(options.excludeCredentials).toEqual([{ id: 'abc', type: 'public-key' }]);
		expect(options.authenticatorSelection.userVerification).toBe('required');
	});
});

describe('authentication', () => {
	it('verifies a real signature', async () => {
		const stored = await registered();
		const challenge = Passkeys.newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(Passkeys.verifyAuthentication(response, challenge, rp, stored)).toBe(0);
	});

	it('rejects a signature from another key', async () => {
		const stored = await registered();
		const other = await TestAuthenticator.create();
		const challenge = Passkeys.newChallenge();
		const response = await other.signIn(challenge, rp);
		expect(() => Passkeys.verifyAuthentication(response, challenge, rp, stored)).toThrow(
			'Bad signature'
		);
	});

	it('rejects a replayed challenge, wrong origin or wrong RP', async () => {
		const stored = await registered();
		const challenge = Passkeys.newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(() =>
			Passkeys.verifyAuthentication(response, Passkeys.newChallenge(), rp, stored)
		).toThrow('Challenge mismatch');
		const phished = await authenticator.signIn(challenge, rp, { origin: 'https://evil.example' });
		expect(() => Passkeys.verifyAuthentication(phished, challenge, rp, stored)).toThrow(
			'Origin mismatch'
		);
		const otherRp = await authenticator.signIn(challenge, rp, { rpId: 'evil.example' });
		expect(() => Passkeys.verifyAuthentication(otherRp, challenge, rp, stored)).toThrow(
			'Wrong RP id'
		);
	});

	it('rejects a counter that does not move forward', async () => {
		const stored = await registered();
		authenticator.counter = 5;
		const challenge = Passkeys.newChallenge();
		const response = await authenticator.signIn(challenge, rp);
		expect(Passkeys.verifyAuthentication(response, challenge, rp, stored)).toBe(5);
		expect(() =>
			Passkeys.verifyAuthentication(response, challenge, rp, { ...stored, signCount: 5 })
		).toThrow('possible cloned key');
	});
});

describe('Passkeys.delete', () => {
	it("only deletes the user's own passkey", async () => {
		const stored = await registered();
		const other = await Users.findOrCreate(db, 'eve@example.com');
		expect(await Passkeys.delete(db, other.id, stored.id)).toBe(false);
		expect(await Passkeys.delete(db, user.id, stored.id)).toBe(true);
		expect(await Passkeys.find(db, stored.id)).toBeNull();
	});
});
