import type { z } from 'zod';

import { createClient } from '@clickhouse/client-web';
import { ZonedDateTime } from '@internationalized/date';

import type { ClickHouseColumn, ClickHouseSettings, TableEngine } from './schema';

import { logger } from '../../monitoring/logger/client';
import { Datetime } from '../../utils/datetime';
import { chTypeOf, compileSchema } from './compiler';
import { defaultReadSettings } from './config';
import { decodeNativeBuffer } from './native-decoder';
import { withTransportRetry } from './retry';

type ChSharedConfig = {
	keepAlive?: boolean;
	password: string;
	requestTimeoutMs?: number;
	settings?: ClickHouseSettings;
	user: string;
};

export type ClickHouseClientConfig = ChSharedConfig & { vpc: Fetcher };

export interface IClickHouseClient {
	command(
		sql: string,
		params?: Record<string, unknown>,
		settings?: ClickHouseSettings
	): Promise<void>;
	insert<S extends z.ZodObject>(
		table: string,
		schema: S,
		rows: z.infer<S>[],
		settings?: ClickHouseSettings
	): Promise<void>;
	rawSelect<S extends z.ZodObject>(
		schema: S,
		sql: string,
		params?: Record<string, unknown>,
		settings?: ClickHouseSettings
	): Promise<z.infer<S>[]>;
	select<T extends z.ZodObject, K extends keyof T['shape'] & string>(
		table: ClickHouseTable<T>,
		columns: K[]
	): Select<T, K>;
}

/** CH wire types whose value must be a JSON *string* on a `JSONCompactEachRow` insert: 64-bit+ ints (a bigint
 *  isn't JSON-serialisable — `JSON.stringify` throws) and `DateTime64` (a JSON number is REJECTED / mis-scaled
 *  as ticks — only a string of fractional epoch seconds parses). Anchored (`^`) so narrower types (`Int32`,
 *  plain `DateTime`) don't match; `U?Int` covers signed + unsigned. NB `Time64` is deliberately absent — CH
 *  wants a `'HH:MM:SS.fff'` CLOCK string for it, not the numeric seconds `String(value)` would emit, so a
 *  `Time64` insert needs a `z.string()` override (like an exact sub-second `DateTime64`). */
const INSERTS_AS_STRING = /^(U?Int(64|128|256)|Interval|DateTime64)/;

// Native-format read client. One instance per (runtime, config); the caller caches it (per-isolate
// singleton via the app's `ch()` factory). Reads run `FORMAT Native` and decode the columnar bytes with
// @clickhouse/rowbinary's leaf readers. Rows are NOT validated — CH is trusted (validation lives at the
// app edges); the ONE boundary transform, DateTime/DateTime64 → ZonedDateTime, rides on the leaf reader.
//
// The primary read surface is a column-SUBSET `select` returning a chainable `Select`: pick columns, then
// refine with `.where / .orderBy / .limitBy / .limit / .offset / .distinct / .settings`; `await` builds the
// engine-correct SQL (`buildSelect`) + runs it. `rawSelect` is the escape hatch for arbitrary `FORMAT
// Native` SQL the typed select can't express (CASTs, functions, aggregates, ad-hoc analytics).
export abstract class ClickHouseClientCore implements IClickHouseClient {
	private readonly chClient: ReturnType<typeof createClient>;

	protected constructor(
		url: string,
		fetchImpl: typeof fetch | undefined,
		{ keepAlive, password, requestTimeoutMs, settings, user }: ChSharedConfig
	) {
		this.chClient = createClient({
			// Applied to every request; a per-query `clickhouse_settings` is merged over these (caller wins).
			clickhouse_settings: settings ?? defaultReadSettings(requestTimeoutMs),
			fetch: fetchImpl,
			// Undefined → client default (keep-alive on); `false` opts into a fresh connection per request.
			keep_alive: keepAlive === false ? { enabled: false } : undefined,
			password,
			request_timeout: requestTimeoutMs ?? 60_000,
			url,
			username: user,
		});
	}

	/** Run a statement that returns no result set — DDL, TRUNCATE, OPTIMIZE, INSERT … SELECT, etc. */
	async command(
		sql: string,
		params?: Record<string, unknown>,
		settings?: ClickHouseSettings
	): Promise<void> {
		await this.withLogging(sql, async () => {
			await this.chClient.command({
				clickhouse_settings: settings,
				query: sql,
				query_params: params,
			});
		});
	}

	/** Insert rows as `JSONCompactEachRow`. The schema's field order IS the column order (assumed to match
	 *  the table), so each row is mapped to a positional array → `INSERT INTO table (…columns) FORMAT
	 *  JSONCompactEachRow`. Rows are NOT validated — CH is trusted (validation lives at the app edges). The
	 *  only value transform is the DateTime boundary: a `ZonedDateTime` serialises to epoch seconds so the
	 *  caller hands `insert` domain instants, not wire numbers. Two wire classes can't ride a JSON number
	 *  and are coerced to strings inline (64-bit+ ints, `DateTime64`/`Time64`). */
	async insert<S extends z.ZodObject>(
		table: string,
		schema: S,
		rows: z.infer<S>[],
		settings?: ClickHouseSettings
	): Promise<void> {
		if (rows.length === 0) return; // nothing to insert — skip the (empty) network round-trip
		const columns = Object.keys(schema.shape);
		const chTypes = columns.map((c) => chTypeOf(schema.shape[c] as z.core.$ZodType) ?? '');
		// Which columns serialise to a JSON string (per `INSERTS_AS_STRING`) — resolved ONCE, then a single flag
		// check in the per-value loop below (a JSON write-side artifact only; the Native read decodes them back).
		const asString = chTypes.map((t) => INSERTS_AS_STRING.test(t));
		// DateTime64 keeps sub-second precision: a ZonedDateTime serialises to FRACTIONAL epoch seconds, not the
		// whole-second `Datetime.toUnixSeconds` used for plain DateTime (which CH truncates to the second anyway).
		const asDateTime64 = chTypes.map((t) => t.startsWith('DateTime64'));
		const values = rows.map((row) => {
			const r = row as Record<string, unknown>;
			// Positional array for JSONCompactEachRow. Domain → wire: a ZonedDateTime → epoch seconds (the
			// DateTime/DateTime64 boundary); the string-transport columns → String. Everything else rides raw.
			return columns.map((column, i) => {
				const raw = r[column];
				const value =
					raw instanceof ZonedDateTime
						? asDateTime64[i]
							? raw.toDate().getTime() / 1000
							: Datetime.toUnixSeconds(raw)
						: raw;
				return asString[i] && value != null ? String(value) : value;
			});
		});
		await this.withLogging(`insert ${table}`, async () => {
			await this.chClient.insert({
				clickhouse_settings: settings,
				columns: columns as [string, ...string[]],
				format: 'JSONCompactEachRow',
				table,
				values,
			});
		});
	}

	/** Escape hatch: run ARBITRARY `FORMAT Native` SQL and decode/validate it against a CH zod schema — for
	 *  reads the typed `select` can't express (a CAST, a function, a table function, aggregates, ad-hoc
	 *  analytics). Prefer `select`; reach for this only when a table column-subset won't do. `compileSchema`
	 *  throws for opaque / undecodable types before any network call. */
	async rawSelect<S extends z.ZodObject>(
		schema: S,
		sql: string,
		params?: Record<string, unknown>,
		settings?: ClickHouseSettings
	): Promise<z.infer<S>[]> {
		return this.execAndDecodeNative(sql, compileSchema(schema), params, settings) as Promise<
			z.infer<S>[]
		>;
	}

	/** Open a column-subset read of a table — returns a chainable `Select`. `.where('id = {id:UInt32}', { id })`
	 *  adds a parameterized WHERE; `.orderBy/.limitBy/.limit/.offset/.distinct` order + page the result (uniform
	 *  across engines — the collapse is handled in the FROM). `await` (or `.then`) builds the engine-correct SQL,
	 *  runs it `FORMAT Native`, decodes + validates against the picked schema. */
	select<T extends z.ZodObject, K extends keyof T['shape'] & string>(
		table: ClickHouseTable<T>,
		columns: K[]
	): Select<T, K> {
		return new SelectImpl<T, K>(table, { columns }, (sql, decodeColumns, params, settings) =>
			this.execAndDecodeNative(sql, decodeColumns, params, settings)
		);
	}

	/** Shared read path: run `sql FORMAT Native`, drain the stream to one buffer, and decode the columnar
	 *  bytes with the precompiled decode columns. No validation — the decode tree yields the rows directly. */
	private async execAndDecodeNative(
		sql: string,
		decodeColumns: ClickHouseColumn[],
		params?: Record<string, unknown>,
		settings?: ClickHouseSettings
	): Promise<Record<string, unknown>[]> {
		// Retry exec + drain (a dropped connection throws) — reads are idempotent; the trace fires when the
		// bytes land, or once the retry is exhausted. Decode stays OUTSIDE the retry so a decode bug isn't
		// misread as a transient blip.
		const bytes = await this.withLogging(sql, () =>
			withTransportRetry(async (signal) => {
				// Strip a trailing `;` — we append ` FORMAT Native`, and `…; FORMAT Native` trips CH's
				// "Multi-statements are not allowed".
				const { stream } = await this.chClient.exec({
					abort_signal: signal,
					clickhouse_settings: settings,
					query: `${sql.replace(/;\s*$/, '')} FORMAT Native`,
					query_params: params,
				});
				// Drain the response stream to one contiguous buffer via the platform Response API (no manual
				// chunk loop). Cursor needs a Node Buffer (string reads use buf.toString('utf8')); Buffer =
				// nodejs_compat.
				return new Response(stream as unknown as ReadableStream<Uint8Array>).arrayBuffer();
			})
		);
		return decodeNativeBuffer(Buffer.from(bytes), decodeColumns);
	}

	/** Run a CH round-trip, reporting ERROR + Sentry on failure. Timing/tracing lives in real spans, not here. */
	private async withLogging<T>(summary: string, run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (err) {
			await logger.error(err, { op: 'clickhouse', summary });
			throw err;
		}
	}
}

export class ClickHouseClient extends ClickHouseClientCore {
	constructor({ vpc, ...config }: ClickHouseClientConfig) {
		super('http://localhost:8123', vpc.fetch.bind(vpc), config);
	}
}

/**
 * A ClickHouse table: a zod object of ALL columns (the single source that drives both Native decode and row
 * validation) + the engine descriptor. Reads go through `ClickHouseClient.select`; the table only compiles the
 * engine-correct SQL (`buildSelect`), cached per read shape. The engine is a runtime value (not a type param) —
 * the chain is uniform (`Select<T,K>`) because the collapse is handled entirely in the FROM, never the tail.
 *
 * PURE and connection-free. Construct ONCE as a module constant: it owns the select cache + per-column decode
 * plans, so an inline `new` in a hot path would get a cold cache every call.
 */
export class ClickHouseTable<T extends z.ZodObject = z.ZodObject> {
	readonly engine: TableEngine;
	readonly name: string;
	/** The zod object of ALL columns — drives Native decode (the wire type + leaf readers). */
	readonly schema: T;
	/** Each column's decode plan, compiled ONCE at construction and keyed by name — so a column shared across
	 *  subsets is compiled a single time; `buildSelect` PICKS from here instead of recompiling per subset. */
	private readonly compiledColumns: Map<string, ClickHouseColumn>;
	/** Built SELECTs (SQL + decode columns), keyed by the read's value-independent shape. */
	private readonly selectCache = new Map<string, { columns: ClickHouseColumn[]; sql: string }>();

	constructor(def: { engine: TableEngine; name: string; schema: T }) {
		this.name = def.name;
		this.schema = def.schema;
		this.engine = def.engine;
		// Compile every column once at construction (tables are module constants): fail-fast on an undecodable
		// column at module load, AND keep the decode plans by name so a column shared across subsets is compiled
		// once — `buildSelect` picks from here rather than recompiling per read.
		this.compiledColumns = new Map(compileSchema(def.schema).map((c) => [c.name, c]));
	}

	/** Build (and memoize) the engine-correct SELECT for a read spec. Keyed by the JSON of the spec's
	 *  value-independent parts — structure-faithful, so a comma in a column name can't collide two reads. */
	cachedSelect(spec: SelectSpec): { columns: ClickHouseColumn[]; sql: string } {
		const key = JSON.stringify([
			spec.columns,
			spec.where ?? null,
			spec.orderBy ?? null,
			spec.limitBy ?? null,
			spec.limit ?? null,
			spec.offset ?? null,
			spec.distinct ?? false,
		]);
		let hit = this.selectCache.get(key);
		if (!hit) {
			hit = this.buildSelect(spec);
			this.selectCache.set(key, hit);
		}
		return hit;
	}

	/** Engine-correct SELECT for a read spec. The collapse lives in the FROM — a bare table (MergeTree/Plain),
	 *  `FINAL` (Replacing/Summing final:true, Collapsing, VersionedCollapsing), or `sum()+GROUP BY` (Summing
	 *  final:false) — so the user tail (`ORDER BY`/`LIMIT BY`/`LIMIT`/`DISTINCT`) appends uniformly on top.
	 *
	 *  The ONE exception is Replacing final:false: its cheap `LIMIT 1 BY` collapse OCCUPIES the `ORDER BY` slot,
	 *  so a read that also carries a user tail is wrapped in a subquery (collapse inside — with the WHERE, to keep
	 *  filter-then-collapse — and the user tail outside). With no user tail it stays flat (byte-identical to a
	 *  bare `LIMIT 1 BY` read), so the common point-read SQL is unchanged. */
	private buildSelect(spec: SelectSpec): {
		columns: ClickHouseColumn[];
		sql: string;
	} {
		const { columns, distinct, limit, limitBy, offset, orderBy, where } = spec;
		const engine = this.engine;
		const proj = columns.join(', ');
		const distinctKw = distinct ? 'DISTINCT ' : '';
		const whereClause = where ? ` WHERE ${where}` : '';
		const orderClause = orderBy?.length
			? ` ORDER BY ${orderBy.map((o) => `${o.column} ${o.dir}`).join(', ')}`
			: '';
		// `LIMIT n BY <keys>` sits AFTER ORDER BY (which decides WHICH n per key) and BEFORE the outer LIMIT.
		const limitByClause = limitBy ? ` LIMIT ${limitBy.n} BY ${limitBy.by.join(', ')}` : '';
		const limitClause =
			limit != null ? ` LIMIT ${limit}${offset != null ? ` OFFSET ${offset}` : ''}` : '';
		const userTail = `${orderClause}${limitByClause}${limitClause}`;

		let sql: string;
		if (engine.kind === 'ReplacingMergeTree' && !engine.final) {
			// Cheap latest-per-key: filter (WHERE) THEN collapse via ORDER BY … LIMIT 1 BY.
			const key = engine.sortKey.join(', ');
			const ordering = engine.version ? `${key}, ${engine.version} DESC` : key;
			const collapse = `${whereClause} ORDER BY ${ordering} LIMIT 1 BY ${key}`;
			if (!distinct && !userTail) {
				sql = `SELECT ${proj} FROM ${this.name}${collapse}`;
			} else {
				// User tail would collide with the collapse's own tail → wrap. The inner must also project the
				// sortKey + version so its ORDER BY / LIMIT 1 BY can reference them; the outer selects just `proj`.
				const innerCols = [
					...new Set([...columns, ...engine.sortKey, ...(engine.version ? [engine.version] : [])]),
				].join(', ');
				sql = `SELECT ${distinctKw}${proj} FROM (SELECT ${innerCols} FROM ${this.name}${collapse})${userTail}`;
			}
		} else {
			// Flat forms: the collapse is a FROM modifier (FINAL) or a same-level GROUP BY, so the user tail appends
			// directly. WHERE sits after FROM — Summing filters before its GROUP BY; FINAL filters after the collapse
			// (its correctness contract). MergeTree/Plain are a bare projection.
			const usesFinal =
				(engine.kind === 'ReplacingMergeTree' && engine.final) ||
				(engine.kind === 'SummingMergeTree' && engine.final) ||
				engine.kind === 'CollapsingMergeTree' ||
				engine.kind === 'VersionedCollapsingMergeTree';
			const base = usesFinal ? `${this.name} FINAL` : this.name;
			let projFinal = proj;
			let groupBy = '';
			if (engine.kind === 'SummingMergeTree' && !engine.final) {
				const measures = new Set<string>(engine.measures);
				projFinal = columns.map((c) => (measures.has(c) ? `sum(${c}) AS ${c}` : c)).join(', ');
				const groupKeys = columns.filter((c) => !measures.has(c));
				if (groupKeys.length) groupBy = ` GROUP BY ${groupKeys.join(', ')}`;
			}
			sql = `SELECT ${distinctKw}${projFinal} FROM ${base}${whereClause}${groupBy}${userTail}`;
		}
		// Pick the decode columns in the COLUMNS-ARRAY order (not the table's field order) so they line up
		// positionally with the SELECT list whatever order the caller picked. Decode plans are picked by name
		// (compiled once at construction, DateTime leaves already guarded), never recompiled per read.
		return { columns: columns.map((c) => this.compiledColumns.get(c)!), sql };
	}
}

/** The value-independent shape of a built read — what `cachedSelect` keys + compiles. `params`/`settings`
 *  are runtime-only and live on the `Select`, not here. */
type SelectSpec = {
	columns: string[];
	distinct?: boolean;
	limit?: number;
	/** `LIMIT n BY <keys>` — keep n rows per distinct key tuple (top-N-per-group). */
	limitBy?: { by: string[]; n: number };
	offset?: number;
	orderBy?: { column: string; dir: 'ASC' | 'DESC' }[];
	where?: string;
};

type Rows<T extends z.ZodObject, K extends keyof T['shape'] & string> = Pick<z.infer<T>, K>[];
type SelectRunner = (
	sql: string,
	decodeColumns: ClickHouseColumn[],
	params?: Record<string, unknown>,
	settings?: ClickHouseSettings
) => Promise<unknown[]>;
// ── the chainable Select ────────────────────────────────────────────────────────────────────────────
type SortDir = 'asc' | 'desc';

/** A chainable read: pick columns, then refine with `.where`/`.orderBy`/`.limitBy`/`.limit`/`.offset`/
 *  `.distinct`/`.settings`. Uniform across engines — the collapse is handled in the FROM (see `buildSelect`),
 *  so every method is available regardless of engine. `await` (or `.then`) builds the SQL + runs it (Native
 *  decode). */
export interface Select<
	T extends z.ZodObject,
	K extends keyof T['shape'] & string,
> extends PromiseLike<Rows<T, K>> {
	distinct(): Select<T, K>;
	limit(n: number): Select<T, K>;
	/** `LIMIT n BY <keys>` — keep n rows per distinct key tuple (top-N-per-group). Pair with `orderBy` to
	 *  decide WHICH n. Replaces any prior `limitBy` on the chain. */
	limitBy(n: number, ...by: K[]): Select<T, K>;
	offset(n: number): Select<T, K>;
	/** Append an `ORDER BY` key (typed column + direction). Call order is the sort precedence. */
	orderBy(column: K, dir?: SortDir): Select<T, K>;
	/** Per-query ClickHouse settings. */
	settings(settings: ClickHouseSettings): Select<T, K>;
	/** Parameterized WHERE template — `where('id = {id:UInt32}', { id })`. */
	where(sql: string, params?: Record<string, unknown>): Select<T, K>;
}

/** Runtime impl of `Select` — accumulates a `SelectSpec`; `then` builds the engine-correct SQL and runs it. */
class SelectImpl<T extends z.ZodObject, K extends keyof T['shape'] & string> implements Select<
	T,
	K
> {
	constructor(
		private readonly table: ClickHouseTable<T>,
		private readonly spec: SelectSpec,
		private readonly run: SelectRunner,
		private readonly params?: Record<string, unknown>,
		private readonly extraSettings?: ClickHouseSettings
	) {}

	distinct(): Select<T, K> {
		return this.patch({ distinct: true });
	}

	limit(n: number): Select<T, K> {
		return this.patch({ limit: n });
	}
	limitBy(n: number, ...by: K[]): Select<T, K> {
		return this.patch({ limitBy: { by, n } });
	}
	offset(n: number): Select<T, K> {
		return this.patch({ offset: n });
	}
	orderBy(column: K, dir: SortDir = 'asc'): Select<T, K> {
		const item = { column, dir: dir === 'desc' ? ('DESC' as const) : ('ASC' as const) };
		return this.patch({ orderBy: [...(this.spec.orderBy ?? []), item] });
	}
	settings(settings: ClickHouseSettings): Select<T, K> {
		return this.patch({}, this.params, settings);
	}
	then<F = Rows<T, K>, J = never>(
		onFulfilled?: ((value: Rows<T, K>) => F | PromiseLike<F>) | null,
		onRejected?: ((reason: unknown) => J | PromiseLike<J>) | null
	): PromiseLike<F | J> {
		const built = this.table.cachedSelect(this.spec);
		return (
			this.run(built.sql, built.columns, this.params, this.extraSettings) as Promise<Rows<T, K>>
		).then(onFulfilled, onRejected);
	}
	where(sql: string, params?: Record<string, unknown>): Select<T, K> {
		return this.patch({ where: sql }, params);
	}

	private patch(
		p: Partial<SelectSpec>,
		params = this.params,
		settings = this.extraSettings
	): Select<T, K> {
		return new SelectImpl<T, K>(this.table, { ...this.spec, ...p }, this.run, params, settings);
	}
}
