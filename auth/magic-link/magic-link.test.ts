import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../config';

import { createTestDb } from '../__fixtures__/db';
import { findOrCreateUser, isEmailAllowed } from '../users';
import {
	consumeMagicLinkToken,
	issueMagicLinkToken,
	MAGIC_LINK_TTL_MS,
	MAX_LIVE_LINKS,
} from './magic-link';

let db: AuthDb;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
	db = await createTestDb();
});

describe('magic links', () => {
	it('works exactly once', async () => {
		const token = await issueMagicLinkToken(db, 'ada@example.com', NOW);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(await consumeMagicLinkToken(db, token!, NOW + 1000)).toBe('ada@example.com');
		expect(await consumeMagicLinkToken(db, token!, NOW + 2000)).toBeNull();
	});

	it('expires', async () => {
		const token = await issueMagicLinkToken(db, 'ada@example.com', NOW);
		expect(await consumeMagicLinkToken(db, token!, NOW + MAGIC_LINK_TTL_MS)).toBeNull();
	});

	it('rejects unknown and malformed tokens', async () => {
		expect(await consumeMagicLinkToken(db, 'f'.repeat(64), NOW)).toBeNull();
		expect(await consumeMagicLinkToken(db, 'not-a-token', NOW)).toBeNull();
	});

	it('caps live links per email, and frees the cap once they expire', async () => {
		for (let i = 0; i < MAX_LIVE_LINKS; i++) {
			expect(await issueMagicLinkToken(db, 'ada@example.com', NOW)).not.toBeNull();
		}
		expect(await issueMagicLinkToken(db, 'ada@example.com', NOW)).toBeNull();
		expect(await issueMagicLinkToken(db, 'bob@example.com', NOW)).not.toBeNull();
		expect(
			await issueMagicLinkToken(db, 'ada@example.com', NOW + MAGIC_LINK_TTL_MS + 1)
		).not.toBeNull();
	});
});

describe('users', () => {
	it('creates a user once per email, case-insensitively', async () => {
		const first = await findOrCreateUser(db, 'Ada@Example.com');
		const again = await findOrCreateUser(db, 'ada@example.com');
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ email: 'ada@example.com', name: 'ada' });
	});

	it('checks the allowlist case-insensitively and fails closed when empty', () => {
		expect(isEmailAllowed('ADA@example.com', 'bob@x.com, ada@example.com')).toBe(true);
		expect(isEmailAllowed('eve@example.com', 'ada@example.com')).toBe(false);
		expect(isEmailAllowed('ada@example.com', '')).toBe(false);
		expect(isEmailAllowed('ada@example.com', undefined)).toBe(false);
	});
});
