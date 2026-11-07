import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { TestDb } from './testing';

import { testDb } from './testing';

let handle: TestDb<Record<string, never>>;

beforeAll(async () => {
	handle = await testDb({
		migrations: [
			'CREATE TABLE notes (id integer PRIMARY KEY AUTOINCREMENT, body text NOT NULL)--> statement-breakpoint\nCREATE VIRTUAL TABLE notes_fts USING fts5(body)',
		],
	});
}, 60_000);

afterAll(async () => {
	await handle.close();
});

describe('testDb', () => {
	it('applies migrations and round-trips rows', async () => {
		await handle.d1.prepare('INSERT INTO notes (body) VALUES (?)').bind('hello').run();
		const row = await handle.d1.prepare('SELECT body FROM notes').first<{ body: string }>();
		expect(row?.body).toBe('hello');
	});

	it('supports FTS5', async () => {
		await handle.d1
			.prepare('INSERT INTO notes_fts (body) VALUES (?)')
			.bind('quick brown fox')
			.run();
		const hit = await handle.d1
			.prepare('SELECT body FROM notes_fts WHERE notes_fts MATCH ?')
			.bind('brown')
			.first<{ body: string }>();
		expect(hit?.body).toBe('quick brown fox');
	});

	it('enforces the 100 bound parameter limit like production D1', async () => {
		const params = Array.from({ length: 101 }, (_, i) => i);
		const placeholders = params.map(() => '?').join(',');
		await expect(
			handle.d1
				.prepare(`SELECT ${placeholders}`)
				.bind(...params)
				.all()
		).rejects.toThrow('too many SQL variables');
	});

	it('disposes Miniflare when a migration fails', async () => {
		await expect(testDb({ migrations: ['NOT VALID SQL'] })).rejects.toThrow();
	}, 60_000);
});
