import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';

import { createTestDb } from '../__fixtures__/db';
import { Users } from '../users';
import { Sessions } from './sessions';

let db: AuthDb;
let userId: number;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
	db = await createTestDb();
	userId = (await Users.findOrCreate(db, 'ada@example.com')).id;
});

describe('Sessions.splitToken', () => {
	it('splits id.secret and rejects anything else', () => {
		expect(Sessions.splitToken('a.b')).toEqual({ id: 'a', secret: 'b' });
		expect(Sessions.splitToken('a')).toBeNull();
		expect(Sessions.splitToken('a.b.c')).toBeNull();
		expect(Sessions.splitToken('.b')).toBeNull();
	});
});

describe('sessions', () => {
	it('validates a fresh session and returns its user', async () => {
		const { token } = await Sessions.create(db, userId, NOW);
		const live = await Sessions.validate(db, token, NOW + 1000);
		expect(live?.user).toMatchObject({ email: 'ada@example.com', id: userId });
		expect(live?.session.expiresAt).toBe(NOW + Sessions.LIFETIME_MS);
	});

	it('rejects a forged secret', async () => {
		const { id } = await Sessions.create(db, userId, NOW);
		expect(await Sessions.validate(db, `${id}.${'0'.repeat(64)}`, NOW)).toBeNull();
	});

	it('rejects an expired session', async () => {
		const { token } = await Sessions.create(db, userId, NOW);
		expect(await Sessions.validate(db, token, NOW + Sessions.LIFETIME_MS)).toBeNull();
	});

	it('renews and deletes', async () => {
		const { id, token } = await Sessions.create(db, userId, NOW);
		const later = NOW + Sessions.LIFETIME_MS - 1000;
		expect(await Sessions.renew(db, id, later)).toBe(later + Sessions.LIFETIME_MS);
		expect(await Sessions.validate(db, token, NOW + Sessions.LIFETIME_MS + 1)).not.toBeNull();
		await Sessions.delete(db, id);
		expect(await Sessions.validate(db, token, NOW)).toBeNull();
	});
});

describe('Sessions.needsRenewal', () => {
	it('renews only in the second half of the lifetime', () => {
		expect(Sessions.needsRenewal(NOW + Sessions.LIFETIME_MS, NOW)).toBe(false);
		expect(Sessions.needsRenewal(NOW + Sessions.RENEW_BELOW_MS - 1, NOW)).toBe(true);
	});
});
