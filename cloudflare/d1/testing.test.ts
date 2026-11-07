import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createD1TestDb, mockD1 } from './testing';

const MIGRATIONS = [
	'CREATE TABLE notes (id integer PRIMARY KEY AUTOINCREMENT, body text NOT NULL)--> statement-breakpoint\nCREATE VIRTUAL TABLE notes_fts USING fts5(body)',
];

describe('mockD1', () => {
	const ctx = mockD1({
		migrations: MIGRATIONS,
		schema: {},
		seed: async ({ d1 }) => {
			await d1.prepare('INSERT INTO notes (body) VALUES (?)').bind('seeded').run();
		},
	});

	it('applies migrations and the seed, shared across the block', async () => {
		const row = await ctx.d1.prepare('SELECT body FROM notes').first<{ body: string }>();
		expect(row?.body).toBe('seeded');
	});

	it('works through drizzle', async () => {
		const rows = await ctx.db.all<{ body: string }>(sql`SELECT body FROM notes`);
		expect(rows).toEqual([{ body: 'seeded' }]);
	});

	it('supports FTS5', async () => {
		await ctx.d1.prepare('INSERT INTO notes_fts (body) VALUES (?)').bind('quick brown fox').run();
		const hit = await ctx.d1
			.prepare('SELECT body FROM notes_fts WHERE notes_fts MATCH ?')
			.bind('brown')
			.first<{ body: string }>();
		expect(hit?.body).toBe('quick brown fox');
	});

	it('enforces the 100 bound parameter limit like production D1', async () => {
		const params = Array.from({ length: 101 }, (_, i) => i);
		const placeholders = params.map(() => '?').join(',');
		await expect(
			ctx.d1
				.prepare(`SELECT ${placeholders}`)
				.bind(...params)
				.all()
		).rejects.toThrow('too many SQL variables');
	});
});

describe('createD1TestDb', () => {
	it('disposes Miniflare and restores the clock when a migration fails', async () => {
		const before = Date.now();
		await expect(
			createD1TestDb({}, ['NOT VALID SQL'], new Date('2026-01-01T12:00:00Z'))
		).rejects.toThrow();
		expect(Math.abs(Date.now() - before)).toBeLessThan(60_000);
	}, 60_000);

	it('freezes the clock until close', async () => {
		const frozen = new Date('2026-01-01T12:00:00Z');
		const handle = await createD1TestDb({}, MIGRATIONS, frozen);
		expect(Date.now()).toBe(frozen.getTime());
		await handle.close();
		expect(Date.now()).toBeGreaterThan(frozen.getTime());
	}, 60_000);
});
