import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { PgliteDatabase } from 'drizzle-orm/pglite';

import { PGlite } from '@electric-sql/pglite';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

// ── PGlite test database ──
//
// A fresh, fully-migrated in-memory Postgres for one test file -- real Postgres (PGlite is the
// actual Postgres engine compiled to WASM, not a mock/emulator), no Docker, no DATABASE_URL,
// isolated per call so tests using this don't need to serialize with each other the way a
// DATABASE_URL-gated integration suite does.

function isAddConstraint(statement: string): boolean {
	return /^ALTER TABLE\b/i.test(statement) && /\bADD CONSTRAINT\b/i.test(statement);
}

// GRANT/REVOKE reference real production Postgres roles provisioned by infra outside migrations --
// irrelevant here, PGlite's default connection already has full privileges.
function isGrantOrRevoke(statement: string): boolean {
	return /^(GRANT|REVOKE)\b/i.test(statement);
}

function collectStatements(migrationsDir: string): string[] {
	const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
	return files
		.flatMap((file) =>
			readFileSync(path.join(migrationsDir, file), 'utf8')
				.split('--> statement-breakpoint')
				.map((s) => s.trim())
				.filter(Boolean)
		)
		.filter((s) => !isGrantOrRevoke(s));
}

// A schema's hand-written `functions.sql` (drizzle can't model functions), as one script with its GRANTs dropped.
function collectFunctions(schemaDir: string): string | undefined {
	const file = path.join(schemaDir, 'functions.sql');
	if (!existsSync(file)) return undefined;
	return readFileSync(file, 'utf8').replace(/^(GRANT|REVOKE)\b.*;$/gim, '');
}

// Every immediate subdirectory of `schemasDir` that ships a `migrations` folder -- so a package
// gaining a new Postgres schema doesn't also need a second, hand-maintained list of schema names
// kept in sync by hand.
function discoverSchemaNames(schemasDir: string): string[] {
	return readdirSync(schemasDir, { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && existsSync(path.join(schemasDir, entry.name, 'migrations'))
		)
		.map((entry) => entry.name);
}

/**
 * A fresh, fully-migrated in-memory Postgres for one test file, wrapped in drizzle over `schema`.
 * `schemasDir` is the package's `schemas/` directory (e.g. `.../db-schemas-postgres/schemas`) --
 * every schema under it gets migrated, not just the ones `schema` imports types from, since a
 * cross-schema FK needs its target table to exist even when nothing here queries it through
 * Drizzle directly.
 *
 * Migrations are applied in two passes across every schema -- everything except `ADD CONSTRAINT`
 * first, then every `ADD CONSTRAINT` after -- rather than schema-by-schema in list order: a
 * circular FK between two schemas (each referencing a table in the other) means no ordering of
 * whole schemas can work; every table has to exist before any FK constraint is added, no matter
 * which schema it's in.
 *
 * `frozenTime`, if given, freezes the clock for the lifetime of the returned client (restored on
 * `close()`) -- PGlite's SQL `now()` is backed by the host JS Date (runs in-process WASM), so any
 * fixture data computed relative to "now" needs the clock already frozen before it's inserted.
 */
export async function createPgliteTestDb<TSchema extends Record<string, unknown>>(
	schema: TSchema,
	schemasDir: string,
	frozenTime?: Date
): Promise<{ close: () => Promise<void>; db: PgliteDatabase<TSchema> }> {
	if (frozenTime) {
		vi.useFakeTimers();
		vi.setSystemTime(frozenTime);
	}

	const pg = new PGlite();
	const schemaNames = discoverSchemaNames(schemasDir);

	for (const name of schemaNames) {
		await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${name};`);
	}

	const allStatements = schemaNames.flatMap((name) =>
		collectStatements(path.join(schemasDir, name, 'migrations'))
	);
	const constraints = allStatements.filter(isAddConstraint);
	const everythingElse = allStatements.filter((s) => !isAddConstraint(s));

	for (const stmt of everythingElse) await pg.exec(stmt);
	for (const stmt of constraints) await pg.exec(stmt);
	for (const name of schemaNames) {
		const functions = collectFunctions(path.join(schemasDir, name));
		if (functions) await pg.exec(functions);
	}

	return {
		close: async () => {
			await pg.close();
			if (frozenTime) vi.useRealTimers();
		},
		db: drizzle(pg, { schema }),
	};
}

// ── JSON fixtures ──
//
// A master fixture file (plus override files merged on top) seeds rows into a table by
// fixture-id -- a local alias, never written to any column -- so other rows can reference one
// another before either has a real DB-assigned id (e.g. a list's `accountId: "a"`), and so a test
// can look the real id back up after seeding by the same name. A row's shape (which fields are
// foreign keys, to which other collection, and whether its primary key needs the fixture-id as a
// fallback value) is read off the table's own drizzle definition via `getTableConfig`, not
// hand-maintained.

export type FixtureFile = Record<string, Record<string, FixtureRow>>;
export type FixtureIdMap = Record<string, Record<string, number | string>>;
export type FixtureRow = Record<string, unknown>;

export type FixtureCollection = {
	/** Boilerplate field values a fixture row can omit -- for a NOT NULL column with no
	 *  meaningful DB-side default (e.g. a jsonb config column), not something schema
	 *  introspection can supply. */
	defaults?: FixtureRow;
	/** A field that references another collection WITHOUT a real DB foreign key constraint --
	 *  schema introspection can only see actual FK constraints, so a denormalized reference has
	 *  to be named here by hand. */
	extraFkFields?: Record<string, string>;
	/** The JSON key fixture files address this collection by. */
	name: string;
	table: PgTable;
};

function qualifiedName(table: PgTable): string {
	const { name, schema } = getTableConfig(table);
	return schema ? `${schema}.${name}` : name;
}

// Finds which JS property name (e.g. "accountId") a column is exposed under on its own table --
// foreign-key/primary-key metadata only gives us DB column names ("account_id"), not the
// camelCase ones fixture rows and `.values()` calls use. Matched by DB name, not object identity:
// a table-level `foreignKey({ columns: [t.accountId], ... })` constraint (as opposed to an inline
// `.references()`) captures a different column object than the one exposed as `table.accountId`,
// even though they're the same column -- verified empirically against a real schema.
function columnPropertyName(table: PgTable, column: PgColumn): string {
	const entry = Object.entries(table).find(
		([, value]) => (value as PgColumn | undefined)?.name === column.name
	);
	if (!entry) throw new Error(`Column ${column.name} not found as a property of its own table`);
	return entry[0];
}

type TableShape = {
	fkFields: Record<string, string>;
	idField: string | undefined;
	idNeedsFixtureKey: boolean;
};

function introspectTable(
	table: PgTable,
	collectionByTableName: Map<string, string>,
	extraFkFields: Record<string, string> = {}
): TableShape {
	const config = getTableConfig(table);
	// A single-column `.primaryKey()` builder marks the column itself (`.primary === true`); a
	// table-level `primaryKey({ columns: [...] })` constraint (e.g. auth.method) doesn't -- it only
	// shows up in `primaryKeys`, verified empirically against a real schema.
	const pk = config.columns.find((c) => c.primary) ?? config.primaryKeys[0]?.columns[0];
	const fkFields: Record<string, string> = { ...extraFkFields };
	for (const fk of config.foreignKeys) {
		const ref = fk.reference();
		const targetCollection = collectionByTableName.get(qualifiedName(ref.foreignTable));
		if (!targetCollection) continue;
		for (const column of ref.columns)
			fkFields[columnPropertyName(table, column)] = targetCollection;
	}
	return {
		fkFields,
		idField: pk && columnPropertyName(table, pk),
		idNeedsFixtureKey: pk ? !pk.hasDefault : false,
	};
}

// A relative-time field written as data instead of code, e.g. `{ "daysAgo": 365 }` or
// `{ "minutesAgo": 5 }` -- resolved against `nowFn()` at seed time rather than baked into the JSON
// as an absolute timestamp, so it stays meaningful regardless of when the suite runs.
function isRelativeTime(value: unknown): value is { daysAgo: number } | { minutesAgo: number } {
	return (
		typeof value === 'object' &&
		value !== null &&
		('daysAgo' in value || 'minutesAgo' in value) &&
		Object.keys(value).length === 1
	);
}

/** Deep-merges override files onto the master fixture, per collection per fixture-id: fields on
 *  an existing fixture-id are overridden, new fixture-ids are added, nothing in master is dropped. */
export function mergeFixtures(master: FixtureFile, overrides: FixtureFile[]): FixtureFile {
	const merged: FixtureFile = structuredClone(master);
	for (const override of overrides) {
		for (const [collection, rows] of Object.entries(override)) {
			merged[collection] ??= {};
			for (const [fixtureId, row] of Object.entries(rows)) {
				merged[collection][fixtureId] = { ...merged[collection][fixtureId], ...row };
			}
		}
	}
	return merged;
}

/**
 * Seeds `master` (plus any override files, merged on top) into a PGlite instance, resolving
 * cross-collection references (e.g. a job's `fromInboxId: "sender"`) to the real id Postgres
 * assigned on insert. Returns the fixture-id -> real-id map so a test can look up rows by the same
 * name they're defined under in the JSON.
 */
export async function seedFixtures(
	pglite: PgliteDatabase<Record<string, unknown>>,
	collections: FixtureCollection[],
	master: FixtureFile,
	overrides: FixtureFile[] = [],
	// A caller freezing the clock for relative fixture dates wants those dates resolved against
	// its own frozen "now" -- passed in rather than imported, so this module doesn't depend on any
	// one app's datetime library. Only required if a fixture actually uses `daysAgo`/`minutesAgo`.
	nowFn?: () => { subtract: (unit: Record<string, number>) => unknown }
): Promise<{ ids: FixtureIdMap }> {
	const collectionByTableName = new Map(collections.map((c) => [qualifiedName(c.table), c.name]));
	const fixtures = mergeFixtures(master, overrides);
	const ids: FixtureIdMap = {};

	for (const { defaults, extraFkFields, name, table } of collections) {
		const { fkFields, idField, idNeedsFixtureKey } = introspectTable(
			table,
			collectionByTableName,
			extraFkFields
		);
		ids[name] = {};
		for (const [fixtureId, row] of Object.entries(fixtures[name] ?? {})) {
			const resolved: FixtureRow = { ...defaults, ...row };
			if (idNeedsFixtureKey && idField) resolved[idField] ??= fixtureId;
			for (const [field, refCollection] of Object.entries(fkFields)) {
				const ref = resolved[field];
				if (typeof ref === 'string') resolved[field] = ids[refCollection][ref];
			}
			for (const [field, value] of Object.entries(resolved)) {
				if (!isRelativeTime(value)) continue;
				if (!nowFn) {
					throw new Error(
						`Fixture "${name}.${fixtureId}.${field}" uses a relative time but no nowFn was passed to seedFixtures()`
					);
				}
				resolved[field] =
					'daysAgo' in value
						? nowFn().subtract({ days: value.daysAgo })
						: nowFn().subtract({ minutes: value.minutesAgo });
			}
			const [inserted] = await pglite
				.insert(table)
				// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each table's own insert shape, fixtures are untyped JSON by design
				.values(resolved as any)
				.returning({ id: table[idField as keyof PgTable] as PgColumn });
			ids[name][fixtureId] = inserted.id as number | string;
		}
	}

	return { ids };
}
