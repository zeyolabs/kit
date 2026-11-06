import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from './config';

import { createTestDb } from './__fixtures__/db';
import { SESSION_LIFETIME_MS, SESSION_RENEW_BELOW_MS } from './config';
import {
	createSession,
	deleteSession,
	needsRenewal,
	renewSession,
	splitSessionToken,
	validateSession,
} from './sessions';
import { findOrCreateUser } from './users';

let db: AuthDb;
let userId: number;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
	db = await createTestDb();
	userId = (await findOrCreateUser(db, 'ada@example.com')).id;
});

describe('splitSessionToken', () => {
	it('splits id.secret and rejects anything else', () => {
		expect(splitSessionToken('a.b')).toEqual({ id: 'a', secret: 'b' });
		expect(splitSessionToken('a')).toBeNull();
		expect(splitSessionToken('a.b.c')).toBeNull();
		expect(splitSessionToken('.b')).toBeNull();
	});
});

describe('sessions', () => {
	it('validates a fresh session and returns its user', async () => {
		const { token } = await createSession(db, userId, NOW);
		const live = await validateSession(db, token, NOW + 1000);
		expect(live?.user).toMatchObject({ email: 'ada@example.com', id: userId });
		expect(live?.session.expiresAt).toBe(NOW + SESSION_LIFETIME_MS);
	});

	it('rejects a forged secret', async () => {
		const { id } = await createSession(db, userId, NOW);
		expect(await validateSession(db, `${id}.${'0'.repeat(64)}`, NOW)).toBeNull();
	});

	it('rejects an expired session', async () => {
		const { token } = await createSession(db, userId, NOW);
		expect(await validateSession(db, token, NOW + SESSION_LIFETIME_MS)).toBeNull();
	});

	it('renews and deletes', async () => {
		const { id, token } = await createSession(db, userId, NOW);
		const later = NOW + SESSION_LIFETIME_MS - 1000;
		expect(await renewSession(db, id, later)).toBe(later + SESSION_LIFETIME_MS);
		expect(await validateSession(db, token, NOW + SESSION_LIFETIME_MS + 1)).not.toBeNull();
		await deleteSession(db, id);
		expect(await validateSession(db, token, NOW)).toBeNull();
	});
});

describe('needsRenewal', () => {
	it('renews only in the second half of the lifetime', () => {
		expect(needsRenewal(NOW + SESSION_LIFETIME_MS, NOW)).toBe(false);
		expect(needsRenewal(NOW + SESSION_RENEW_BELOW_MS - 1, NOW)).toBe(true);
	});
});
