import type { D1Database } from '@cloudflare/workers-types';

import { drizzle } from 'drizzle-orm/d1';

// A real D1 for tests: Miniflare runs workerd's own D1 implementation, so the limits production
// has (100 bound parameters per statement, FTS5, batch semantics) hold in tests too. A plain SQLite
// stand-in would pass queries that fail on D1. Needs `miniflare` (an optional peer dependency),
// which is imported lazily so apps that never call `testDb` don't load it.

export type TestDb<Schema extends Record<string, unknown>> = {
	/** Stops the Miniflare instance. Call it in `afterAll`. */
	close(): Promise<void>;
	/** The raw D1 binding, for tests that need `prepare`, `batch` or `exec`. */
	d1: D1Database;
	/** The drizzle client over D1, with `schema` for relational queries. */
	db: ReturnType<typeof drizzle<Schema>>;
};

/**
 * Starts an in-memory D1 and applies `migrations` in order. Each entry is one SQL statement or a
 * drizzle migration file's contents (`--> statement-breakpoint` separates its statements).
 */
export async function testDb<
	Schema extends Record<string, unknown> = Record<string, never>,
>(options: { migrations: readonly string[]; schema?: Schema }): Promise<TestDb<Schema>> {
	const { Miniflare } = await import('miniflare');
	const miniflare = new Miniflare({
		d1Databases: { DB: crypto.randomUUID() },
		modules: true,
		script: 'export default { fetch() { return new Response(null); } }',
	});
	const d1 = (await miniflare.getD1Database('DB')) as unknown as D1Database;
	const statements = options.migrations
		.flatMap((migration) => migration.split('--> statement-breakpoint'))
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
	if (statements.length > 0) {
		await d1.batch(statements.map((statement) => d1.prepare(statement)));
	}
	return {
		close: () => miniflare.dispose(),
		d1,
		db: drizzle(d1, { schema: options.schema }) as TestDb<Schema>['db'],
	};
}
