import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthDb } from '../../config';

import { createTestDb } from '../../__fixtures__/db';
import { Allowlist } from '../../users';
import { Users } from '../../users';
import { MagicLink } from './magic-link';

let db: AuthDb;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
	db = await createTestDb();
});

describe('magic links', () => {
	it('works exactly once', async () => {
		const token = await MagicLink.issue(db, 'ada@example.com', NOW);
		expect(token).toMatch(/^[0-9a-f]{64}$/);
		expect(await MagicLink.consume(db, token!, NOW + 1000)).toBe('ada@example.com');
		expect(await MagicLink.consume(db, token!, NOW + 2000)).toBeNull();
	});

	it('expires', async () => {
		const token = await MagicLink.issue(db, 'ada@example.com', NOW);
		expect(await MagicLink.consume(db, token!, NOW + MagicLink.TTL_MS)).toBeNull();
	});

	it('rejects unknown and malformed tokens', async () => {
		expect(await MagicLink.consume(db, 'f'.repeat(64), NOW)).toBeNull();
		expect(await MagicLink.consume(db, 'not-a-token', NOW)).toBeNull();
	});

	it('caps live links per email, and frees the cap once they expire', async () => {
		for (let i = 0; i < MagicLink.MAX_LIVE; i++) {
			expect(await MagicLink.issue(db, 'ada@example.com', NOW)).not.toBeNull();
		}
		expect(await MagicLink.issue(db, 'ada@example.com', NOW)).toBeNull();
		expect(await MagicLink.issue(db, 'bob@example.com', NOW)).not.toBeNull();
		expect(await MagicLink.issue(db, 'ada@example.com', NOW + MagicLink.TTL_MS + 1)).not.toBeNull();
	});
});

describe('users', () => {
	it('creates a user once per email, case-insensitively', async () => {
		const first = await Users.findOrCreate(db, 'Ada@Example.com');
		const again = await Users.findOrCreate(db, 'ada@example.com');
		expect(again.id).toBe(first.id);
		expect(first).toMatchObject({ email: 'ada@example.com', name: 'ada' });
	});

	it('checks the allowlist case-insensitively and fails closed when empty', () => {
		expect(Allowlist.includes('ADA@example.com', 'bob@x.com, ada@example.com')).toBe(true);
		expect(Allowlist.includes('eve@example.com', 'ada@example.com')).toBe(false);
		expect(Allowlist.includes('ada@example.com', '')).toBe(false);
		expect(Allowlist.includes('ada@example.com', undefined)).toBe(false);
	});
});
