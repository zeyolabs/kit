import type { D1Database } from '@cloudflare/workers-types';
import type { Miniflare as MiniflareClass } from 'miniflare';

import { drizzle } from 'drizzle-orm/d1';
import { afterAll, beforeAll, vi } from 'vitest';

// A real D1 for tests, the D1 counterpart of `storage/postgres/testing` (`createPgliteTestDb`):
// Miniflare runs workerd's own D1, so the limits production has (100 bound parameters per
// statement, FTS5, batch semantics) hold in tests too. A plain SQLite stand-in would pass queries
// that fail on D1. Needs `miniflare` (an optional peer dependency), imported lazily so apps that
// never call these don't load it.
//
// Like glasa: this file is the low-level piece. An app wraps it once in its own `tests/db.ts`
// (its schema, its migrations, its fixtures) and its tests call that wrapper's `mockDb()`.

export type D1TestDb<TSchema extends Record<string, unknown>> = {
	/** Stops the Miniflare instance (and restores the clock if it was frozen). Call it in `afterAll`. */
	close(): Promise<void>;
	/** The raw D1 binding, for tests that need `prepare`, `batch` or `exec`. */
	d1: D1Database;
	/** The drizzle client over D1, with `schema` for relational queries. */
	db: ReturnType<typeof drizzle<TSchema>>;
};

/**
 * A fresh, fully-migrated in-memory D1 for one test file, wrapped in drizzle over `schema`. Each
 * `migrations` entry is one SQL statement or a drizzle migration file's contents
 * (`--> statement-breakpoint` separates its statements), applied in order. `frozenTime`, if given,
 * freezes `Date` until `close()` so fixture data computed relative to "now" is stable. The clock
 * stays frozen for the whole test file, so code that measures elapsed time with `Date.now()` (and
 * `vi.waitFor`) sees it frozen too.
 */
export async function createD1TestDb<TSchema extends Record<string, unknown>>(
	schema: TSchema,
	migrations: readonly string[],
	frozenTime?: Date
): Promise<D1TestDb<TSchema>> {
	let Miniflare: typeof MiniflareClass;
	try {
		({ Miniflare } = await import('miniflare'));
	} catch (error) {
		throw new Error(
			'createD1TestDb needs the optional peer dependency "miniflare": add it to your devDependencies.',
			{ cause: error }
		);
	}
	if (frozenTime) {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(frozenTime);
	}
	const miniflare = new Miniflare({
		d1Databases: { DB: crypto.randomUUID() },
		modules: true,
		script: 'export default { fetch() { return new Response(null); } }',
	});
	const restoreClock = () => {
		if (frozenTime) vi.useRealTimers();
	};
	try {
		const d1 = (await miniflare.getD1Database('DB')) as unknown as D1Database;
		const statements = migrations
			.flatMap((migration) => migration.split('--> statement-breakpoint'))
			.map((statement) => statement.trim())
			.filter((statement) => statement.length > 0);
		if (statements.length > 0) {
			await d1.batch(statements.map((statement) => d1.prepare(statement)));
		}
		return {
			close: async () => {
				await miniflare.dispose();
				restoreClock();
			},
			d1,
			db: drizzle(d1, { schema }) as D1TestDb<TSchema>['db'],
		};
	} catch (error) {
		// A bad migration must not leave workerd running, or the test run can hang.
		await miniflare.dispose();
		restoreClock();
		throw error;
	}
}

/**
 * Wires `createD1TestDb` into a `describe` block's `beforeAll`/`afterAll`: call once at the top of
 * the block, then read `.db` / `.d1` inside any `it()`. Every `it()` in the block shares the one
 * database; use a separate `describe` for anything that needs its own. `seed` runs once after the
 * migrations (fixtures). An app wraps this in its own `mockDb()` with its schema and migrations.
 */
export function mockD1<TSchema extends Record<string, unknown>>(options: {
	frozenTime?: Date;
	migrations: readonly string[];
	schema: TSchema;
	seed?: (handle: D1TestDb<TSchema>) => Promise<void>;
}): { d1: D1Database; db: D1TestDb<TSchema>['db'] } {
	// Populated by beforeAll before any it() in this describe block runs; the cast reflects that
	// timing guarantee, not the object's real shape at declaration time.
	const ctx = {} as { d1: D1Database; db: D1TestDb<TSchema>['db'] };
	let handle: D1TestDb<TSchema>;

	beforeAll(async () => {
		handle = await createD1TestDb(options.schema, options.migrations, options.frozenTime);
		ctx.d1 = handle.d1;
		ctx.db = handle.db;
		await options.seed?.(handle);
	}, 60_000);

	afterAll(async () => {
		await handle?.close();
	});

	return ctx;
}
