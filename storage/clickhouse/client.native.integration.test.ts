import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Datetime } from '../../utils/datetime';
import { ClickHouseTable } from './client';
import { ClickHouseDevClient } from './dev';
import {
	AggregateFunctionNativeDecodingError,
	IntervalColumnUnsupportedError,
	UndecodableColumnError,
	UnsupportedClickHouseTypeError,
} from './error';
import { CH } from './schema';

// Round-trip harness for the Native decoder against a REAL ClickHouse. Gated on CLICKHOUSE_URL so the
// default `pnpm test` stays offline; point it at a local or remote (WARP) instance to run:
//
//   CLICKHOUSE_URL=http://localhost:8123 CLICKHOUSE_USER=default CLICKHOUSE_PASSWORD=... \
//     pnpm test:integration
//
// TWO read paths, both the actual CLIENT API:
//   • `ch.select(table, cols, …)` — the typed, column-subset read. Used wherever a test reads a REAL persisted
//     table (the scalar-type coverage, the wrapper columns, the insert round-trips).
//   • `ch.rawSelect(schema, sql)` — the arbitrary-`FORMAT Native`-SQL escape hatch. Used for the decoder-only
//     wire types that have no real column to select from: values built inline (`SELECT toUInt32(7) AS d`,
//     `CAST(… AS Nullable(…))`), table functions (`numbers()`, `values()`), Variant/Nested/geo via CAST, the
//     empty-result probe, etc. A column-subset `select` is table-bound and can't express arbitrary SQL.
// Both decode `FORMAT Native`, validate each row against the schema, and assert wire-vs-schema.
const url = process.env.CLICKHOUSE_URL;
const user = process.env.CLICKHOUSE_USER ?? 'default';
const password = process.env.CLICKHOUSE_PASSWORD ?? '';
const TABLE = 'default.ch_native_probe';
const SCALARS = 'default.ch_native_scalars';

describe.skipIf(!url)('ClickHouse Native decode (live CH)', () => {
	let ch: ClickHouseDevClient;

	// Every storable scalar type as a REAL column — the stored column type IS the wire type the decoder
	// reads, so no CAST-in-SELECT. beforeAll inserts one boundary-value row via ch.insert; the test reads it
	// back through `ch.select` (the actual client read path), picking every column.
	const scalarCols = z.object({
		b_false: CH.Bool,
		b_true: CH.Bool,
		d: CH.Date,
		d32: CH.Date32,
		dec64: CH.Decimal(18, 2),
		dt: CH.DateTime,
		dt64_3: CH.DateTime64(3, 'UTC'),
		dt64_6: CH.DateTime64(6, 'UTC'),
		dt64_9: CH.DateTime64(9, 'UTC'),
		e16: CH.Enum(16, { x: 1, y: 1000 }),
		e8: CH.Enum(8, { a: 1, b: 2 }),
		f32: CH.Float32,
		f64: CH.Float64,
		i128: CH.Int128,
		i16: CH.Int16,
		i256: CH.Int256,
		i32: CH.Int32,
		i64: CH.Int64,
		i8: CH.Int8,
		id: CH.UUID,
		s_empty: CH.String,
		s_fixed: CH.FixedString(4),
		s_string: CH.String,
		s_unicode: CH.String,
		t64: CH.Time64(3),
		u128: CH.UInt128,
		u16: CH.UInt16,
		u256: CH.UInt256,
		u32: CH.UInt32,
		u64: CH.UInt64,
		u8: CH.UInt8,
	});
	const Scalars = new ClickHouseTable({
		engine: { kind: 'MergeTree' },
		name: SCALARS,
		schema: scalarCols,
	});
	const allScalarCols = Object.keys(scalarCols.shape) as (keyof typeof scalarCols.shape & string)[];

	// A people-shaped MergeTree table — all the column WRAPPERS (Nullable / Array / LowCardinality /
	// Map) as real persisted columns, read through `ch.select`.
	const People = new ClickHouseTable({
		engine: { kind: 'MergeTree' },
		name: TABLE,
		schema: z.object({
			attrs: z.record(CH.String, CH.String),
			created: CH.DateTime,
			email: CH.String.nullable(),
			id: CH.UInt32,
			name: CH.String,
			phones: z.array(CH.String),
			src: CH.LowCardNullableString,
			status: CH.LowCardString,
		}),
	});

	beforeAll(async () => {
		ch = new ClickHouseDevClient({ password, url: url!, user });
		// Seed a real MergeTree table (people-shaped) so wrapper reads exercise persisted-column
		// serialization — LowCardinality dictionaries especially — not just CAST-in-SELECT.
		await ch.command(`DROP TABLE IF EXISTS ${TABLE}`);
		await ch.command(
			`CREATE TABLE ${TABLE} (
				id UInt32, name String, email Nullable(String), phones Array(String),
				status LowCardinality(String), src LowCardinality(Nullable(String)),
				attrs Map(String, String), created DateTime('UTC')
			) ENGINE = MergeTree ORDER BY id`
		);
		await ch.command(
			`INSERT INTO ${TABLE} SELECT
				number,
				'name' || toString(number),
				if(number % 5 = 0, NULL, 'e' || toString(number)),
				if(number % 2 = 0, ['p1', 'p2'], []),
				['active', 'closed', 'pending'][number % 3 + 1],
				if(number % 4 = 0, NULL, ['gmail', 'outlook'][number % 2 + 1]),
				map('k', toString(number)),
				toDateTime('2024-01-01 00:00:00', 'UTC') + number
			FROM numbers(2000)`
		);

		// Persisted, exactly-typed scalar columns — the type-coverage test reads these back without casts.
		await ch.command(`DROP TABLE IF EXISTS ${SCALARS}`);
		await ch.command(
			`CREATE TABLE ${SCALARS} (
				s_empty String, s_string String, s_unicode String, s_fixed FixedString(4),
				u8 UInt8, u16 UInt16, u32 UInt32, u64 UInt64, u128 UInt128,
				i8 Int8, i16 Int16, i32 Int32, i64 Int64, i128 Int128,
				f32 Float32, f64 Float64, b_true Bool, b_false Bool,
				d Date, d32 Date32, dt DateTime('UTC'),
				dt64_3 DateTime64(3, 'UTC'), dt64_6 DateTime64(6, 'UTC'), dt64_9 DateTime64(9, 'UTC'),
				id UUID, dec64 Decimal(18, 2),
				e8 Enum8('a' = 1, 'b' = 2), e16 Enum16('x' = 1, 'y' = 1000),
				u256 UInt256, i256 Int256, t64 Time64(3)
			) ENGINE = MergeTree ORDER BY tuple()`
		);
		// DateTime64 + Time64 insert as datetime/clock STRINGS (a JSON number is read as ticks at the column
		// scale, not seconds — and a numeric string is rejected for Time64), so dt64_*/t64 are overridden to
		// z.string(). Everything else inserts as its natural JSON value; 64-bit+ ints (incl. u256/i256) go
		// as numeric strings via `INSERTS_AS_STRING`.
		await ch.insert(
			SCALARS,
			scalarCols.extend({
				dt64_3: z.string(),
				dt64_6: z.string(),
				dt64_9: z.string(),
				t64: z.string(),
			}),
			[
				{
					b_false: false,
					b_true: true,
					d: '2024-02-29',
					d32: '2024-02-29',
					dec64: '1234.56',
					dt: Date.UTC(2024, 0, 15, 12, 34, 56) / 1000,
					dt64_3: '2024-01-15 12:34:56.789',
					dt64_6: '2024-01-15 12:34:56.789012',
					dt64_9: '2024-01-15 12:34:56.789012345',
					e16: 'y',
					e8: 'b',
					f32: 1.5,
					f64: 3.141592653589793,
					i128: 170141183460469231731687303715884105727n,
					i16: -32768,
					i256: 57896044618658097711785492504343953926634992332820282019728792003956564819967n,
					i32: -2147483648,
					i64: -9223372036854775808n,
					i8: -128,
					id: '0192c0de-cafe-7000-8000-0123456789ab',
					s_empty: '',
					s_fixed: 'ab', // FixedString(4) — CH pads to 'ab'
					s_string: 'plain',
					s_unicode: '日本語🎉',
					t64: '01:02:03.500',
					u128: 340282366920938463463374607431768211455n,
					u16: 65535,
					u256: 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
					u32: 4294967295,
					u64: 18446744073709551615n,
					u8: 255,
				},
			]
		);
	});

	it('decodes every supported scalar type to the expected value', async () => {
		// Read the persisted, exactly-typed columns seeded in beforeAll through the CLIENT (ch.select).
		const [row] = await ch.select(Scalars, allScalarCols);

		expect(row.s_empty).toBe('');
		expect(row.s_string).toBe('plain');
		expect(row.s_unicode).toBe('日本語🎉');
		expect(row.s_fixed).toBe('ab\u0000\u0000'); // FixedString keeps trailing NULs
		expect(row.u8).toBe(255);
		expect(row.u16).toBe(65535);
		expect(row.u32).toBe(4294967295);
		expect(row.u64).toBe(18446744073709551615n);
		expect(row.u128).toBe(340282366920938463463374607431768211455n);
		expect(row.i8).toBe(-128);
		expect(row.i16).toBe(-32768);
		expect(row.i32).toBe(-2147483648);
		expect(row.i64).toBe(-9223372036854775808n);
		expect(row.i128).toBe(170141183460469231731687303715884105727n);
		expect(row.f32).toBeCloseTo(1.5, 6);
		expect(row.f64).toBe(3.141592653589793);
		expect(row.b_true).toBe(true);
		expect(row.b_false).toBe(false);
		expect(row.d).toBe('2024-02-29');
		expect(row.d32).toBe('2024-02-29');
		const baseSec = Date.UTC(2024, 0, 15, 12, 34, 56) / 1000;
		expect(row.dt).toBe(baseSec);
		expect(row.dt64_3).toBeCloseTo(baseSec + 0.789, 3);
		expect(row.dt64_6).toBeCloseTo(baseSec + 0.789012, 6);
		expect(row.dt64_9).toBeCloseTo(baseSec + 0.789012345, 6);
		expect(row.id).toBe('0192c0de-cafe-7000-8000-0123456789ab');
		expect(row.dec64).toBe('1234.56');
		expect(row.e8).toBe('b');
		expect(row.e16).toBe('y');
		expect(row.u256).toBe(
			115792089237316195423570985008687907853269984665640564039457584007913129639935n
		); // UInt256 max — inserted as a numeric string, decoded back to bigint
		expect(row.i256).toBe(
			57896044618658097711785492504343953926634992332820282019728792003956564819967n
		); // Int256 max
		expect(row.t64).toBeCloseTo(3723.5, 3); // Time64(3) → fractional seconds-of-day (01:02:03.500)
	});

	it('decodes Nullable and (nested) Array column framing (wrappers composed from primitives)', async () => {
		const [row] = await ch.rawSelect(
			z.object({
				arr_u32: z.array(CH.UInt32), // → Array(UInt32)
				arr_empty: z.array(CH.String), // → Array(String)
				arr_nested: z.array(z.array(CH.String)), // → Array(Array(String))
				arr_null: z.array(CH.UInt32.nullable()), // → Array(Nullable(UInt32))
				n_null: CH.String.nullable(), // → Nullable(String)
				n_val: CH.String.nullable(),
				n_nullish: CH.String.nullish(), // optional(nullable(String)) → Nullable(String)
			}),
			`SELECT
				[1, 2, 3]::Array(UInt32) AS arr_u32,
				[]::Array(String) AS arr_empty,
				[['a', 'b'], ['c']]::Array(Array(String)) AS arr_nested,
				[10, NULL, 30]::Array(Nullable(UInt32)) AS arr_null,
				NULL::Nullable(String) AS n_null,
				'x'::Nullable(String) AS n_val,
				'y'::Nullable(String) AS n_nullish`
		);

		expect(row.arr_u32).toEqual([1, 2, 3]);
		expect(row.arr_empty).toEqual([]);
		expect(row.arr_nested).toEqual([['a', 'b'], ['c']]);
		expect(row.arr_null).toEqual([10, null, 30]);
		expect(row.n_null).toBeNull();
		expect(row.n_val).toBe('x');
		expect(row.n_nullish).toBe('y');
	});

	it('sees through transparent zod wrappers (default / catch / readonly / brand)', async () => {
		// These don't change the wire type. .default()/.catch()/.readonly() unwrap to the inner; .brand()
		// is type-only (returns the same instance), so its meta is untouched.
		const [row] = await ch.rawSelect(
			z.object({
				d: CH.UInt32.default(0), // → UInt32
				ct: CH.String.catch('fallback'), // → String
				ro: CH.String.readonly(), // → String
				br: CH.String.brand('Tag'), // → String (brand is type-only)
				arr: z.array(CH.UInt32.default(0)), // → Array(UInt32)
			}),
			`SELECT toUInt32(7) AS d, 'hi' AS ct, 'ro' AS ro, 'tag' AS br, [1, 2]::Array(UInt32) AS arr`
		);
		expect(row.d).toBe(7);
		expect(row.ct).toBe('hi');
		expect(row.ro).toBe('ro');
		expect(row.br).toBe('tag');
		expect(row.arr).toEqual([1, 2]);
	});

	it('derives the CH type through a transform/pipe from the input side', async () => {
		// CHPrimitive.transform(fn) puts the meta on the pipe's input — chTypeOf reads pipe.def.in.
		const [row] = await ch.rawSelect(
			z.object({
				doubled: CH.UInt32.transform((n) => n * 2), // pipe input CH.UInt32 → UInt32
				ts: CH.DateTime.transform((sec) => new Date(sec * 1000)), // epoch seconds → Date
			}),
			`SELECT toUInt32(21) AS doubled, toDateTime('2024-01-15 12:00:00', 'UTC') AS ts`
		);
		expect(row.doubled).toBe(42);
		expect(row.ts).toEqual(new Date(Date.UTC(2024, 0, 15, 12, 0, 0)));
	});

	it('reconstructs z.map → JS Map (typed keys) and z.set → JS Set', async () => {
		const [row] = await ch.rawSelect(
			z.object({
				m: z.map(CH.UInt32, CH.String), // Map(UInt32, String) → JS Map with NUMBER keys
				tags: z.set(CH.String), // Array(String) → JS Set (dedups)
			}),
			`SELECT
				map(toUInt32(1), 'a', toUInt32(2), 'b') AS m,
				['x', 'x', 'y']::Array(String) AS tags`
		);
		expect(row.m).toBeInstanceOf(Map);
		expect(row.m.get(1)).toBe('a'); // number key preserved, not the string "1"
		expect(row.m.get(2)).toBe('b');
		expect(row.tags).toBeInstanceOf(Set);
		expect([...row.tags]).toEqual(['x', 'y']);
	});

	it('markMapSetNodes flags Map/Set nodes at any depth (nested containers)', async () => {
		// Each column forces markMapSetNodes to recurse — through Array, a Map value, and a Tuple — to
		// reach an inner z.map/z.set and flag it (top-level marking wouldn't catch these).
		const [row] = await ch.rawSelect(
			z.object({
				mapsInArray: z.array(z.map(CH.UInt32, CH.String)), // Array(Map(UInt32, String))
				setsInArray: z.array(z.set(CH.String)), // Array(Array(String))
				setInMapValue: z.map(CH.String, z.set(CH.UInt32)), // Map(String, Array(UInt32))
				mapInTuple: z.object({ m: z.map(CH.String, CH.String) }), // Tuple(m Map(String, String))
			}),
			`SELECT
				[map(toUInt32(1), 'a'), map(toUInt32(2), 'b')]::Array(Map(UInt32, String)) AS mapsInArray,
				[['x', 'x'], ['y']]::Array(Array(String)) AS setsInArray,
				map('k', [10, 10, 20])::Map(String, Array(UInt32)) AS setInMapValue,
				CAST(tuple(map('a', 'b')), 'Tuple(m Map(String, String))') AS mapInTuple`
		);

		// Array → Map (recursed through the array; number keys preserved)
		expect(row.mapsInArray.every((m) => m instanceof Map)).toBe(true);
		expect(row.mapsInArray[0].get(1)).toBe('a');
		expect(row.mapsInArray[1].get(2)).toBe('b');

		// Array → Set
		expect(row.setsInArray.every((s) => s instanceof Set)).toBe(true);
		expect(row.setsInArray.map((s) => [...s])).toEqual([['x'], ['y']]);

		// Map value → Set (recursed into the map's value node)
		expect(row.setInMapValue).toBeInstanceOf(Map);
		expect(row.setInMapValue.get('k')).toBeInstanceOf(Set);
		expect([...row.setInMapValue.get('k')!]).toEqual([10, 20]);

		// Tuple → Map (recursed into the tuple field)
		expect(row.mapInTuple.m).toBeInstanceOf(Map);
		expect(row.mapInTuple.m.get('a')).toBe('b');
	});

	it('decodes z.map → Map consistently across repeated reads of the same schema', async () => {
		// Re-reading the same hoisted schema must rebuild `attrs` as a Map every time — the asMap flag is
		// derived during compilation (markMapSet folded into compileColumn), so it holds on each read.
		const IdAttrsCHRow = z.object({ id: CH.UInt32, attrs: z.map(CH.String, CH.String) });
		const read = (n: number) =>
			ch.rawSelect(IdAttrsCHRow, `SELECT toUInt32(${n}) AS id, map('k', toString(${n})) AS attrs`);

		for (const n of [1, 2, 3]) {
			const [row] = await read(n);
			expect(row.id).toBe(n);
			expect(row.attrs).toBeInstanceOf(Map);
			expect(row.attrs.get('k')).toBe(String(n));
		}
	});

	it('rejects non-derivable zod types (Lazy / Intersection / meta-less transform family)', async () => {
		const cases = [
			z.object({ x: z.lazy(() => z.string()) }), // inner has no .meta
			z.object({ x: z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() })) }),
			z.object({ x: z.string().transform((s) => s) }), // pipe input z.string() has no .meta
			z.object({ x: z.preprocess((v) => v, z.string()) }),
			z.object({ x: z.codec(z.string(), z.string(), { decode: (s) => s, encode: (s) => s }) }),
		];
		for (const schema of cases) {
			await expect(ch.rawSelect(schema, 'SELECT 1 AS x')).rejects.toThrow(UndecodableColumnError);
		}
	});

	it('returns an empty array for a zero-row result', async () => {
		expect(await ch.rawSelect(z.object({ x: CH.UInt8 }), 'SELECT 1 AS x WHERE 0')).toEqual([]);
	});

	it('decodes LowCardinality(String) and LowCardinality(Nullable(String))', async () => {
		const rows = await ch.rawSelect(
			z.object({ lc: CH.LowCardString, lcn: CH.LowCardNullableString }),
			`SELECT
				CAST(arrayElement(['red', 'green', 'red', 'blue'], number + 1), 'LowCardinality(String)') AS lc,
				CAST(arrayElement(['a', NULL, 'a', 'b'], number + 1), 'LowCardinality(Nullable(String))') AS lcn
				FROM numbers(4)`
		);
		expect(rows.map((r) => r.lc)).toEqual(['red', 'green', 'red', 'blue']);
		expect(rows.map((r) => r.lcn)).toEqual(['a', null, 'a', 'b']);
	});

	it('decodes LowCardinality across multiple blocks (per-block dictionary)', async () => {
		const rows = await ch.rawSelect(
			z.object({ lc: CH.LowCardString }),
			`SELECT CAST(toString(number % 3), 'LowCardinality(String)') AS lc FROM numbers(2000)`,
			undefined,
			{ max_block_size: 500 }
		);
		expect(rows).toHaveLength(2000);
		expect(rows[0].lc).toBe('0');
		expect(rows[1999].lc).toBe(String(1999 % 3));
	});

	it('decodes Map columns', async () => {
		const rows = await ch.rawSelect(
			z.object({ m: z.record(CH.String, CH.UInt32) }), // → Map(String, UInt32)
			`SELECT map('k' || toString(number), toUInt32(number * 10)) AS m FROM numbers(3)`
		);
		expect(rows[0].m).toEqual({ k0: 0 });
		expect(rows[1].m).toEqual({ k1: 10 });
		expect(rows[2].m).toEqual({ k2: 20 });
	});

	it('decodes anonymous and named Tuples', async () => {
		const rows = await ch.rawSelect(
			z.object({
				anon: z.tuple([CH.UInt32, CH.String]), // → Tuple(UInt32, String)
				named: z.object({ a: CH.UInt32, b: CH.String }), // → Tuple(a UInt32, b String)
			}),
			`SELECT
				(toUInt32(number), 'v' || toString(number))::Tuple(UInt32, String) AS anon,
				CAST((toUInt32(number * 10), 'n' || toString(number)), 'Tuple(a UInt32, b String)') AS named
			FROM numbers(2)`
		);
		expect(rows[0].anon).toEqual([0, 'v0']);
		expect(rows[1].anon).toEqual([1, 'v1']);
		expect(rows[0].named).toEqual({ a: 0, b: 'n0' });
		expect(rows[1].named).toEqual({ a: 10, b: 'n1' });
	});

	it('reads every wrapper from a REAL MergeTree table across multiple blocks', async () => {
		// Through the client: pick every column, ordered by id; multi-block decode forced with a small block.
		const rows = await ch
			.select(People, ['id', 'name', 'email', 'phones', 'status', 'src', 'attrs', 'created'])
			.orderBy('id')
			.settings({ max_block_size: 500 });
		expect(rows).toHaveLength(2000);

		const base = Date.UTC(2024, 0, 1) / 1000;
		const statuses = ['active', 'closed', 'pending'];
		expect(rows.every((r, i) => r.status === statuses[i % 3])).toBe(true);
		expect(
			rows.every((r, i) => r.src === (i % 4 === 0 ? null : i % 2 === 0 ? 'gmail' : 'outlook'))
		).toBe(true);
		expect(rows.every((r, i) => r.id === i && r.created === base + i)).toBe(true);
		expect(rows[0]).toMatchObject({
			attrs: { k: '0' },
			email: null,
			name: 'name0',
			phones: ['p1', 'p2'],
		});
		expect(rows[1999]).toMatchObject({
			attrs: { k: '1999' },
			email: 'e1999',
			name: 'name1999',
			phones: [],
		});
	});

	it('decodes IP, Time/Time64, BFloat16, and geo types', async () => {
		const [row] = await ch.rawSelect(
			z.object({
				ipv4: CH.IPv4,
				ipv6: CH.IPv6,
				t: CH.Time,
				t64: CH.Time64(3),
				bf: CH.BFloat16,
				point: CH.Point,
				ring: CH.Ring,
				linestring: CH.LineString,
				polygon: CH.Polygon,
				multilinestring: CH.MultiLineString,
				multipolygon: CH.MultiPolygon,
			}),
			`SELECT
				toIPv4('192.168.1.1') AS ipv4,
				toIPv6('2001:db8::1') AS ipv6,
				CAST(3661, 'Time') AS t,
				CAST('01:01:01.500', 'Time64(3)') AS t64,
				CAST(1.5, 'BFloat16') AS bf,
				(1.5, 2.5)::Point AS point,
				[(0., 0.), (1., 1.)]::Ring AS ring,
				[(0., 0.), (2., 2.)]::LineString AS linestring,
				[[(0., 0.), (1., 0.), (1., 1.)]]::Polygon AS polygon,
				[[(0., 0.), (1., 1.)], [(2., 2.), (3., 3.)]]::MultiLineString AS multilinestring,
				[[[(0., 0.), (1., 0.), (1., 1.)]]]::MultiPolygon AS multipolygon`
		);
		expect(row.ipv4).toBe('192.168.1.1');
		expect(row.ipv6).toBe('2001:db8::1');
		expect(row.t).toBe(3661);
		expect(row.t64).toBeCloseTo(3661.5, 3);
		expect(row.bf).toBeCloseTo(1.5, 6);
		expect(row.point).toEqual([1.5, 2.5]);
		expect(row.ring).toEqual([
			[0, 0],
			[1, 1],
		]);
		expect(row.linestring).toEqual([
			[0, 0],
			[2, 2],
		]);
		expect(row.polygon).toEqual([
			[
				[0, 0],
				[1, 0],
				[1, 1],
			],
		]);
		expect(row.multilinestring).toEqual([
			[
				[0, 0],
				[1, 1],
			],
			[
				[2, 2],
				[3, 3],
			],
		]);
		expect(row.multipolygon).toEqual([
			[
				[
					[0, 0],
					[1, 0],
					[1, 1],
				],
			],
		]);
	});

	it('decodes Variant (discriminators + compacted per-variant columns) via CH.Variant', async () => {
		// CH.Variant builds the `Variant(String, UInt64)` ch string + a null-inclusive validation union.
		const rows = await ch.rawSelect(
			z.object({ v: CH.Variant(CH.String, CH.UInt64) }),
			`SELECT v FROM values('v Variant(UInt64, String)', (42), ('hi'), (NULL))`
		);
		expect(rows.map((r) => r.v)).toEqual([42n, 'hi', null]);
	});

	it('decodes Nested (as Array(Tuple)) via CH.Nested', async () => {
		// CH.Nested({ x, y }) builds `Nested(x UInt32, y String)` + z.array(z.object(...)).
		const [row] = await ch.rawSelect(
			z.object({ n: CH.Nested({ x: CH.UInt32, y: CH.String }) }),
			`SELECT CAST([(1, 'a'), (2, 'b')], 'Nested(x UInt32, y String)') AS n`
		);
		expect(row.n).toEqual([
			{ x: 1, y: 'a' },
			{ x: 2, y: 'b' },
		]);
	});

	it('validates + transforms through the column zod, and asserts wire-vs-schema', async () => {
		const rows = await ch.rawSelect(
			z.object({
				n: CH.UInt64,
				label: CH.String.transform((s) => `L${s}`),
			}),
			'SELECT number AS n, toString(number) AS label FROM numbers(3)'
		);
		expect(rows).toEqual([
			{ label: 'L0', n: 0n },
			{ label: 'L1', n: 1n },
			{ label: 'L2', n: 2n },
		]);
		await expect(
			ch.rawSelect(z.object({ id: CH.String }), 'SELECT toUInt32(1) AS id')
		).rejects.toThrow(/wire type UInt32 ≠ schema String/);
	});

	it('fails loud on opaque/unsupported CH types (well-defined error classes)', async () => {
		await expect(
			ch.rawSelect(
				z.object({ x: z.unknown().meta({ ch: 'AggregateFunction(sum, UInt64)' }) }),
				'SELECT 1 AS x'
			)
		).rejects.toThrow(AggregateFunctionNativeDecodingError);
		await expect(
			ch.rawSelect(z.object({ x: z.unknown().meta({ ch: 'Dynamic' }) }), 'SELECT 1 AS x')
		).rejects.toThrow(UnsupportedClickHouseTypeError);
		await expect(
			ch.rawSelect(z.object({ x: z.unknown().meta({ ch: 'JSON' }) }), 'SELECT 1 AS x')
		).rejects.toThrow(UnsupportedClickHouseTypeError);
		// Interval columns are deliberately unsupported — the decoder throws its own error (prefer an int column).
		await expect(
			ch.rawSelect(z.object({ x: z.unknown().meta({ ch: 'IntervalDay' }) }), 'SELECT 1 AS x')
		).rejects.toThrow(IntervalColumnUnsupportedError);
	});
});

describe.skipIf(!url)('ClickHouse insert/query round-trip (live CH)', () => {
	const RT = 'default.ch_native_roundtrip';
	// One wire-form schema drives both insert (domain → JSONCompactEachRow) and query (Native → domain).
	const Row = z.object({
		big: CH.UInt64, // > 2^53 — travels as a JSON string both ways
		created: CH.DateTime, // epoch seconds
		flag: CH.Bool,
		id: CH.UInt32,
		name: CH.String,
		note: CH.String.nullable(),
		precise: CH.DateTime64(3, 'UTC'), // fractional epoch seconds (read); insert subsecond as a string
	});
	const Rt = new ClickHouseTable({ engine: { kind: 'MergeTree' }, name: RT, schema: Row });
	// Same table, but `created` typed as the domain ZonedDateTime so `select` transforms the epoch on read.
	const RtZoned = new ClickHouseTable({
		engine: { kind: 'MergeTree' },
		name: RT,
		schema: Row.extend({ created: CH.ZonedDateTime }),
	});
	let ch: ClickHouseDevClient;

	beforeAll(async () => {
		ch = new ClickHouseDevClient({ password, url: url!, user });
		await ch.command(`DROP TABLE IF EXISTS ${RT}`);
		await ch.command(`CREATE TABLE ${RT} (
			id UInt32, name String, big UInt64, flag Bool,
			created DateTime('UTC'), precise DateTime64(3, 'UTC'), note Nullable(String)
		) ENGINE = MergeTree ORDER BY id`);
	});

	afterAll(async () => {
		await ch.command(`DROP TABLE IF EXISTS ${RT}`);
	});

	it('inserts (JSONCompactEachRow) and reads back scalars, bigint, DateTime, DateTime64', async () => {
		const epoch = Date.UTC(2024, 0, 15, 12, 0, 0) / 1000;
		// DateTime takes an epoch number; DateTime64 is handed the SAME domain (fractional epoch seconds) and
		// `toJsonWireValue` stringifies it for JSON — a bare number would be rejected/mis-scaled by CH.
		await ch.insert(RT, Row, [
			{
				big: 9007199254740993n,
				created: epoch,
				flag: true,
				id: 1,
				name: 'a',
				note: 'hi',
				precise: epoch + 0.789,
			},
			{
				big: 18446744073709551615n,
				created: epoch + 1,
				flag: false,
				id: 2,
				name: 'b',
				note: null,
				precise: epoch + 1, // whole number → stored as epoch seconds, not raw ticks
			},
		]);

		const rows = (
			await ch.select(Rt, ['id', 'name', 'big', 'flag', 'created', 'precise', 'note'])
		).sort((a, b) => a.id - b.id);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			big: 9007199254740993n,
			flag: true,
			id: 1,
			name: 'a',
			note: 'hi',
		});
		expect(rows[0].created).toBe(epoch); // DateTime epoch round-trips through a JSON-number insert
		expect(rows[0].precise).toBeCloseTo(epoch + 0.789, 3); // DateTime64 subsecond round-trips as a number
		expect(rows[1]).toMatchObject({ big: 18446744073709551615n, flag: false, id: 2, note: null });
		expect(rows[1].precise).toBe(epoch + 1);
	});

	it('still accepts a DateTime64 as a datetime string via a z.string() override (exact sub-second)', async () => {
		// The number form (fractional epoch seconds) loses precision past ~µs; for an exact sub-second value you
		// can override the field to z.string() and pass a datetime string — `toJsonWireValue` leaves it untouched
		// (no leaf `ch`), so this escape hatch coexists with the number form.
		const sec = Date.UTC(2024, 0, 15, 12, 0, 0) / 1000;
		await ch.insert(RT, Row.extend({ precise: z.string() }), [
			{
				big: 0n,
				created: 0,
				flag: false,
				id: 42,
				name: 'x',
				note: null,
				precise: '2024-01-15 12:00:00.123',
			},
		]);
		const [row] = await ch.select(Rt, ['id', 'precise']).where('id = {id:UInt32}', { id: 42 });
		expect(row.precise).toBeCloseTo(sec + 0.123, 3);
	});

	it('round-trips a domain ZonedDateTime: insert serialises it (codec encode), select decodes it back', async () => {
		const original = Datetime.zonedFromUnixSeconds(Date.UTC(2024, 5, 1, 9, 30, 0) / 1000);
		// Hand insert the DOMAIN instant directly — the CH.ZonedDateTime codec encodes it to epoch on the way
		// in (no toUnixSeconds at the call site); RtZoned's `created` codec decodes it back on the way out.
		await ch.insert(RT, RtZoned.schema, [
			{
				big: 0n,
				created: original,
				flag: true,
				id: 10,
				name: 'z',
				note: null,
				precise: Date.UTC(2024, 5, 1, 9, 30, 0) / 1000,
			},
		]);
		const [row] = await ch
			.select(RtZoned, ['id', 'name', 'big', 'flag', 'created', 'precise', 'note'])
			.where('id = {id:UInt32}', { id: 10 });
		// row.created IS a ZonedDateTime (codec decode); compare() === 0 ⇒ same instant survived the round-trip.
		expect(row.created.compare(original)).toBe(0);
	});
});

// The column-subset read surface: `ClickHouseTable.cachedSelect(spec)` writes engine-correct SQL from a read
// spec (columns + where + orderBy/limitBy/limit/offset/distinct); `ch.select(table, cols).where(…).orderBy(…)…`
// accumulates that spec then runs it Native-decoded. SQL generation needs no live CH. The chain is uniform
// across engines — the collapse lives in the FROM, so the user tail always appends (wrapping only when a
// Replacing final:false read's LIMIT 1 BY collapse would collide with it).
describe('ClickHouseTable.cachedSelect — engine-correct SQL (offline)', () => {
	const People = new ClickHouseTable({
		engine: { final: false, kind: 'ReplacingMergeTree', sortKey: ['id'], version: 'version' },
		name: 'public.people',
		schema: z.object({ id: CH.UInt32, name: CH.String, slug: CH.String, version: CH.UInt32 }),
	});
	const PeopleFinal = new ClickHouseTable({
		engine: { final: true, kind: 'ReplacingMergeTree', sortKey: ['id'], version: 'version' },
		name: 'public.people',
		schema: People.schema,
	});
	const Usage = new ClickHouseTable({
		engine: {
			final: false,
			kind: 'SummingMergeTree',
			measures: ['count'],
			sortKey: ['source', 'day'],
		},
		name: 'analytics.usage',
		schema: z.object({ count: CH.UInt64, day: CH.Date, source: CH.String }),
	});
	const Logs = new ClickHouseTable({
		engine: { kind: 'MergeTree' },
		name: 'app.logs',
		schema: z.object({ id: CH.UInt32, msg: CH.String }),
	});
	const Signups = new ClickHouseTable({
		engine: { kind: 'CollapsingMergeTree' },
		name: 'analytics.signups',
		schema: z.object({ count: CH.Int64, id: CH.UInt32 }),
	});

	it('MergeTree: explicit column list + parameterized WHERE template', () => {
		expect(Logs.cachedSelect({ columns: ['id', 'msg'] }).sql).toBe('SELECT id, msg FROM app.logs');
		expect(Logs.cachedSelect({ columns: ['id'], where: 'id > {min:UInt32}' }).sql).toBe(
			'SELECT id FROM app.logs WHERE id > {min:UInt32}'
		);
	});

	it('MergeTree: distinct / orderBy / limit / offset append flatly after WHERE', () => {
		expect(
			Logs.cachedSelect({
				columns: ['id', 'msg'],
				distinct: true,
				limit: 10,
				offset: 5,
				orderBy: [{ column: 'id', dir: 'DESC' }],
				where: 'id > {min:UInt32}',
			}).sql
		).toBe(
			'SELECT DISTINCT id, msg FROM app.logs WHERE id > {min:UInt32} ORDER BY id DESC LIMIT 10 OFFSET 5'
		);
	});

	it('MergeTree: LIMIT n BY sits after ORDER BY and before the outer LIMIT', () => {
		expect(
			Logs.cachedSelect({
				columns: ['id', 'msg'],
				limit: 100,
				limitBy: { by: ['msg'], n: 2 },
				orderBy: [{ column: 'id', dir: 'DESC' }],
			}).sql
		).toBe('SELECT id, msg FROM app.logs ORDER BY id DESC LIMIT 2 BY msg LIMIT 100');
	});

	it('ReplacingMergeTree (final:false): latest-per-key via LIMIT 1 BY', () => {
		expect(People.cachedSelect({ columns: ['id', 'name'] }).sql).toBe(
			'SELECT id, name FROM public.people ORDER BY id, version DESC LIMIT 1 BY id'
		);
	});

	it('ReplacingMergeTree (final:true): FINAL collapse, then orderBy/limit append after FINAL', () => {
		expect(PeopleFinal.cachedSelect({ columns: ['id', 'name'] }).sql).toBe(
			'SELECT id, name FROM public.people FINAL'
		);
		expect(
			PeopleFinal.cachedSelect({
				columns: ['id', 'name'],
				limit: 5,
				orderBy: [{ column: 'id', dir: 'DESC' }],
			}).sql
		).toBe('SELECT id, name FROM public.people FINAL ORDER BY id DESC LIMIT 5');
	});

	it('SummingMergeTree: sum(measure) + GROUP BY the key columns', () => {
		expect(Usage.cachedSelect({ columns: ['source', 'day', 'count'] }).sql).toBe(
			'SELECT source, day, sum(count) AS count FROM analytics.usage GROUP BY source, day'
		);
	});

	it('SummingMergeTree: user tail appends flatly after GROUP BY (no wrap needed)', () => {
		expect(Usage.cachedSelect({ columns: ['source'], limit: 10 }).sql).toBe(
			'SELECT source FROM analytics.usage GROUP BY source LIMIT 10'
		);
	});

	it('CollapsingMergeTree: reads via FINAL, user tail appends flatly', () => {
		expect(Signups.cachedSelect({ columns: ['id', 'count'] }).sql).toBe(
			'SELECT id, count FROM analytics.signups FINAL'
		);
		expect(
			Signups.cachedSelect({ columns: ['id'], limit: 5, orderBy: [{ column: 'id', dir: 'ASC' }] })
				.sql
		).toBe('SELECT id FROM analytics.signups FINAL ORDER BY id ASC LIMIT 5');
	});

	it('ReplacingMergeTree (final:false): a user tail wraps the LIMIT 1 BY collapse in a subquery', () => {
		// The collapse occupies the ORDER BY slot, so the user ORDER BY can't append at the same level →
		// collapse inside, user tail outside. No user tail stays flat (asserted above).
		expect(
			People.cachedSelect({ columns: ['id', 'name'], orderBy: [{ column: 'id', dir: 'DESC' }] }).sql
		).toBe(
			'SELECT id, name FROM (SELECT id, name, version FROM public.people ORDER BY id, version DESC LIMIT 1 BY id) ORDER BY id DESC'
		);
		// WHERE stays INSIDE the collapse (filter-then-collapse — the final:false contract), user tail outside.
		expect(
			People.cachedSelect({ columns: ['id'], limit: 10, where: 'id > {min:UInt32}' }).sql
		).toBe(
			'SELECT id FROM (SELECT id, version FROM public.people WHERE id > {min:UInt32} ORDER BY id, version DESC LIMIT 1 BY id) LIMIT 10'
		);
	});

	it('caches the built SELECT per read shape on the table instance', () => {
		expect(People.cachedSelect({ columns: ['id', 'name'] })).toBe(
			People.cachedSelect({ columns: ['id', 'name'] })
		);
		expect(People.cachedSelect({ columns: ['id'] })).not.toBe(
			People.cachedSelect({ columns: ['id', 'name'] })
		);
		expect(People.cachedSelect({ columns: ['id'], where: 'id = {id:UInt32}' })).not.toBe(
			People.cachedSelect({ columns: ['id'] })
		);
	});

	// Type-level: the chain is now UNIFORM — every method is available on EVERY engine (the old per-engine gate
	// is gone). This only needs to compile; esbuild strips it, vitest never runs it.

	function _uniformChain(ch: ClickHouseDevClient) {
		ch.select(Logs, ['id', 'msg'])
			.orderBy('id', 'desc')
			.limitBy(2, 'msg')
			.limit(10)
			.offset(5)
			.distinct();
		ch.select(People, ['id']).orderBy('id').limitBy(1, 'id').limit(5); // Replacing final:false — now allowed
		ch.select(Usage, ['source']).orderBy('source').limit(10); // Summing final:false — now allowed
		ch.select(Signups, ['id']).orderBy('id').distinct(); // Collapsing (FINAL) — now allowed
	}
	void _uniformChain; // referenced so it isn't flagged unused — it exists only for the type checks above
});

describe.skipIf(!url)('ClickHouseClient.select — column subset (live CH)', () => {
	const MT = 'default.ch_buildselect_mt';
	const RMT = 'default.ch_buildselect_rmt';
	let ch: ClickHouseDevClient;
	const Logs = new ClickHouseTable({
		engine: { kind: 'MergeTree' },
		name: MT,
		schema: z.object({ id: CH.UInt32, msg: CH.String }),
	});
	const Events = new ClickHouseTable({
		engine: { final: false, kind: 'ReplacingMergeTree', sortKey: ['id'], version: 'version' },
		name: RMT,
		schema: z.object({ id: CH.UInt32, name: CH.String, version: CH.UInt32 }),
	});

	beforeAll(async () => {
		ch = new ClickHouseDevClient({ password, url: url!, user });
		await ch.command(`DROP TABLE IF EXISTS ${MT}`);
		await ch.command(`CREATE TABLE ${MT} (id UInt32, msg String) ENGINE = MergeTree ORDER BY id`);
		await ch.insert(MT, Logs.schema, [
			{ id: 1, msg: 'one' },
			{ id: 2, msg: 'two' },
		]);
		await ch.command(`DROP TABLE IF EXISTS ${RMT}`);
		await ch.command(
			`CREATE TABLE ${RMT} (id UInt32, name String, version UInt32) ENGINE = ReplacingMergeTree(version) ORDER BY id`
		);
		await ch.insert(RMT, Events.schema, [
			{ id: 1, name: 'a', version: 1 },
			{ id: 1, name: 'a2', version: 2 }, // id=1's latest is 'a2'
			{ id: 2, name: 'b', version: 1 },
		]);
	});
	afterAll(async () => {
		await ch.command(`DROP TABLE IF EXISTS ${MT}`);
		await ch.command(`DROP TABLE IF EXISTS ${RMT}`);
	});

	it('MergeTree: column subset + WHERE', async () => {
		const rows = (await ch.select(Logs, ['id', 'msg']).where('id > {min:UInt32}', { min: 1 })).sort(
			(a, b) => a.id - b.id
		);
		expect(rows).toEqual([{ id: 2, msg: 'two' }]);
	});

	it('ReplacingMergeTree: latest-per-key collapse', async () => {
		const rows = (await ch.select(Events, ['id', 'name'])).sort((a, b) => a.id - b.id);
		expect(rows).toEqual([
			{ id: 1, name: 'a2' },
			{ id: 2, name: 'b' },
		]);
	});

	it('ReplacingMergeTree (final:false) + orderBy/limit: collapse-then-order via the subquery wrap', async () => {
		// Latest-per-key is {1:a2, 2:b}; DESC by id + limit 1 → just id=2. The wrap collapses first (inside),
		// then orders/limits (outside) — a JS sort couldn't page server-side.
		const rows = await ch.select(Events, ['id', 'name']).orderBy('id', 'desc').limit(1);
		expect(rows).toEqual([{ id: 2, name: 'b' }]);
	});

	it('MergeTree: orderBy + limit + offset chain (server-ordered, no JS sort)', async () => {
		// id 1,2 seeded → DESC gives [2,1]; limit 1 offset 0 → just id=2.
		const rows = await ch.select(Logs, ['id', 'msg']).orderBy('id', 'desc').limit(1);
		expect(rows).toEqual([{ id: 2, msg: 'two' }]);
		const second = await ch.select(Logs, ['id', 'msg']).orderBy('id', 'desc').limit(1).offset(1);
		expect(second).toEqual([{ id: 1, msg: 'one' }]);
	});

	it('MergeTree: LIMIT n BY keeps the top-n rows per key (server-side, no JS grouping)', async () => {
		const HITS = 'default.qb_limitby';
		const Hits = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: HITS,
			schema: z.object({ ts: CH.UInt32, user_id: CH.UInt32 }),
		});
		await ch.command(`DROP TABLE IF EXISTS ${HITS}`);
		await ch.command(
			`CREATE TABLE ${HITS} (user_id UInt32, ts UInt32) ENGINE = MergeTree ORDER BY (user_id, ts)`
		);
		await ch.insert(HITS, Hits.schema, [
			{ ts: 10, user_id: 1 },
			{ ts: 20, user_id: 1 },
			{ ts: 30, user_id: 1 },
			{ ts: 15, user_id: 2 },
			{ ts: 25, user_id: 2 },
		]);
		// Latest 2 ts per user_id: user 1 → 30,20 (drops 10); user 2 → 25,15.
		const rows = await ch
			.select(Hits, ['user_id', 'ts'])
			.orderBy('user_id')
			.orderBy('ts', 'desc')
			.limitBy(2, 'user_id');
		expect(rows.sort((a, b) => a.user_id - b.user_id || b.ts - a.ts)).toEqual([
			{ ts: 30, user_id: 1 },
			{ ts: 20, user_id: 1 },
			{ ts: 25, user_id: 2 },
			{ ts: 15, user_id: 2 },
		]);
		await ch.command(`DROP TABLE IF EXISTS ${HITS}`);
	});
});

// Probe: an inline `CHEmail` = `CH.String` with `.min`/`.max` refinements layered on. Tests that the zod
// refinements compose with a CH primitive end-to-end — the `.meta({ ch, read })` must survive the `.min().max()`
// chain for the ClickHouseTable constructor to derive the wire type + decoder, AND the length bounds must still
// validate on insert.
describe.skipIf(!url)(
	'inline CHEmail (CH.String + .min/.max) through ClickHouseTable (live CH)',
	() => {
		const EMAIL_TABLE = 'default.ch_email_probe';
		let ch: ClickHouseDevClient;

		beforeAll(async () => {
			ch = new ClickHouseDevClient({ password, url: url!, user });
			await ch.command(`DROP TABLE IF EXISTS ${EMAIL_TABLE}`);
			await ch.command(
				`CREATE TABLE ${EMAIL_TABLE} (id UInt32, email String) ENGINE = MergeTree ORDER BY id`
			);
		});
		afterAll(async () => {
			await ch.command(`DROP TABLE IF EXISTS ${EMAIL_TABLE}`);
		});

		it('inserts + selects a refined CHEmail and enforces its length bounds', async () => {
			// Inline refinement on the CH primitive — constructing the table compiles `email`, so if `.min/.max`
			// dropped the ch/read meta this `new ClickHouseTable` would throw UndecodableColumnError right here.
			const CHEmail = CH.String.min(6).max(254);
			const Contacts = new ClickHouseTable({
				engine: { kind: 'MergeTree' },
				name: EMAIL_TABLE,
				schema: z.object({ email: CHEmail, id: CH.UInt32 }),
			});
			await ch.insert(EMAIL_TABLE, Contacts.schema, [
				{ email: 'ada@example.com', id: 1 },
				{ email: 'grace@example.com', id: 2 },
			]);
			const rows = (await ch.select(Contacts, ['id', 'email'])).sort((a, b) => a.id - b.id);
			expect(rows).toEqual([
				{ email: 'ada@example.com', id: 1 },
				{ email: 'grace@example.com', id: 2 },
			]);
			// The .min/.max validation rides along: an out-of-bounds value is rejected before it reaches CH.
			await expect(
				ch.insert(EMAIL_TABLE, Contacts.schema, [{ email: 'a@b', id: 3 }])
			).rejects.toThrow();
		});
	}
);

// The full zod-validator catalog layered onto CH primitives, end-to-end through ClickHouseTable → insert
// (validates) → select (decodes + validates). Skips what's already covered elsewhere: string .min/.max (the
// CHEmail probe) and the transparent wrappers / .transform (the decode suite).
describe.skipIf(!url)('zod validators on CH primitives through ClickHouseTable (live CH)', () => {
	const NUM = 'default.ch_zv_num';
	const STR = 'default.ch_zv_str';
	const ARR = 'default.ch_zv_arr';
	const SET = 'default.ch_zv_set';
	const OW = 'default.ch_zv_ow';
	const FMT = 'default.ch_zv_fmt';
	let ch: ClickHouseDevClient;

	beforeAll(async () => {
		ch = new ClickHouseDevClient({ password, url: url!, user });
		for (const sql of [
			`DROP TABLE IF EXISTS ${NUM}`,
			`CREATE TABLE ${NUM} (id UInt32, u UInt32, i Int32, f Float64, b UInt64) ENGINE = MergeTree ORDER BY id`,
			`DROP TABLE IF EXISTS ${STR}`,
			`CREATE TABLE ${STR} (id UInt32, s String, t String) ENGINE = MergeTree ORDER BY id`,
			`DROP TABLE IF EXISTS ${ARR}`,
			`CREATE TABLE ${ARR} (id UInt32, a Array(String), a2 Array(UInt32), a3 Array(UInt32)) ENGINE = MergeTree ORDER BY id`,
			`DROP TABLE IF EXISTS ${SET}`,
			`CREATE TABLE ${SET} (id UInt32, tags Array(String)) ENGINE = MergeTree ORDER BY id`,
			`DROP TABLE IF EXISTS ${OW}`,
			`CREATE TABLE ${OW} (id UInt32, email String, code String, norm String, slug String) ENGINE = MergeTree ORDER BY id`,
			`DROP TABLE IF EXISTS ${FMT}`,
			`CREATE TABLE ${FMT} (id UInt32, email String, site String, ref String, even String, at String) ENGINE = MergeTree ORDER BY id`,
		])
			await ch.command(sql);
	});
	afterAll(async () => {
		for (const t of [NUM, STR, ARR, SET, OW, FMT]) await ch.command(`DROP TABLE IF EXISTS ${t}`);
	});

	it('number & bigint checks (int/positive/negative/nonnegative/nonpositive/gt/gte/lt/lte/multipleOf)', async () => {
		const T = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: NUM,
			schema: z.object({
				b: CH.UInt64.nonnegative().multipleOf(10n).gte(10n).lte(1000n),
				f: CH.Float64.gt(0).lt(1),
				i: CH.Int32.int().negative().nonpositive().gt(-100).gte(-50),
				id: CH.UInt32,
				u: CH.UInt32.int().positive().multipleOf(5).lte(100),
			}),
		});
		await ch.insert(NUM, T.schema, [{ b: 500n, f: 0.5, i: -10, id: 1, u: 50 }]);
		expect(await ch.select(T, ['id', 'u', 'i', 'f', 'b'])).toEqual([
			{ b: 500n, f: 0.5, i: -10, id: 1, u: 50 },
		]);
		await expect(
			ch.insert(NUM, T.schema, [{ b: 500n, f: 0.5, i: -10, id: 2, u: 7 }])
		).rejects.toThrow(); // u not ×5
		await expect(
			ch.insert(NUM, T.schema, [{ b: 500n, f: 0.5, i: -10, id: 2, u: 0 }])
		).rejects.toThrow(); // u not positive
		await expect(
			ch.insert(NUM, T.schema, [{ b: 500n, f: 0.5, i: 5, id: 2, u: 50 }])
		).rejects.toThrow(); // i not negative
		await expect(
			ch.insert(NUM, T.schema, [{ b: 500n, f: 2, i: -10, id: 2, u: 50 }])
		).rejects.toThrow(); // f not <1
		await expect(
			ch.insert(NUM, T.schema, [{ b: 15n, f: 0.5, i: -10, id: 2, u: 50 }])
		).rejects.toThrow(); // b not ×10
	});

	it('string checks (length/regex/startsWith/endsWith/includes/lowercase/uppercase)', async () => {
		const T = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: STR,
			schema: z.object({
				id: CH.UInt32,
				s: CH.String.regex(/^[a-z0-9_]+$/)
					.startsWith('u_')
					.includes('adm')
					.lowercase(),
				t: CH.String.length(4).endsWith('Z').uppercase(),
			}),
		});
		await ch.insert(STR, T.schema, [{ id: 1, s: 'u_admin', t: 'ABYZ' }]);
		expect(await ch.select(T, ['id', 's', 't'])).toEqual([{ id: 1, s: 'u_admin', t: 'ABYZ' }]);
		await expect(ch.insert(STR, T.schema, [{ id: 2, s: 'U_ADMIN', t: 'ABYZ' }])).rejects.toThrow(); // lowercase/regex
		await expect(ch.insert(STR, T.schema, [{ id: 2, s: 'admin', t: 'ABYZ' }])).rejects.toThrow(); // startsWith
		await expect(ch.insert(STR, T.schema, [{ id: 2, s: 'u_xyz', t: 'ABYZ' }])).rejects.toThrow(); // includes 'adm'
		await expect(ch.insert(STR, T.schema, [{ id: 2, s: 'u_admin', t: 'abyz' }])).rejects.toThrow(); // uppercase
		await expect(ch.insert(STR, T.schema, [{ id: 2, s: 'u_admin', t: 'ABYZX' }])).rejects.toThrow(); // length 4
	});

	it('array & set checks (array min/max/length/nonempty; set min via the read path)', async () => {
		const Arrays = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: ARR,
			schema: z.object({
				a: z.array(CH.String).min(1).max(3),
				a2: z.array(CH.UInt32).length(2),
				a3: z.array(CH.UInt32).nonempty(),
				id: CH.UInt32,
			}),
		});
		await ch.insert(ARR, Arrays.schema, [{ a: ['x', 'y'], a2: [10, 20], a3: [9], id: 1 }]);
		expect(await ch.select(Arrays, ['id', 'a', 'a2', 'a3'])).toEqual([
			{ a: ['x', 'y'], a2: [10, 20], a3: [9], id: 1 },
		]);
		await expect(
			ch.insert(ARR, Arrays.schema, [{ a: [], a2: [10, 20], a3: [9], id: 2 }])
		).rejects.toThrow(); // a < min 1
		await expect(
			ch.insert(ARR, Arrays.schema, [{ a: ['a', 'b', 'c', 'd'], a2: [10, 20], a3: [9], id: 2 }])
		).rejects.toThrow(); // a > max 3
		await expect(
			ch.insert(ARR, Arrays.schema, [{ a: ['x'], a2: [10], a3: [9], id: 2 }])
		).rejects.toThrow(); // a2 ≠ length 2

		// z.set decodes Array→Set, so its size checks run on the READ path (insert can't serialize a Set —
		// seed via a plain array schema, then read through a z.set(...).min(2) column).
		const Tags = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: SET,
			schema: z.object({ id: CH.UInt32, tags: z.set(CH.String).min(2) }),
		});
		await ch.insert(SET, z.object({ id: CH.UInt32, tags: z.array(CH.String) }), [
			{ id: 10, tags: ['x', 'y', 'z'] }, // 3 distinct → Set size 3, passes min(2)
			{ id: 11, tags: ['x', 'x'] }, // dedups to 1 → Set size 1, fails min(2) on read
		]);
		const ok = await ch.select(Tags, ['id', 'tags']).where('id = {id:UInt32}', { id: 10 });
		expect([...ok[0].tags].sort()).toEqual(['x', 'y', 'z']);
		await expect(
			ch.select(Tags, ['id', 'tags']).where('id = {id:UInt32}', { id: 11 })
		).rejects.toThrow(); // Set size 1 < 2
	});

	it('value-mutating overwrites rewrite on insert AND read (trim/toLowerCase/toUpperCase/normalize/slugify)', async () => {
		const T = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: OW,
			schema: z.object({
				code: CH.String.trim().toUpperCase(),
				email: CH.String.trim().toLowerCase(),
				id: CH.UInt32,
				norm: CH.String.normalize(), // NFC
				slug: CH.String.slugify(),
			}),
		});
		await ch.insert(OW, T.schema, [
			{ code: ' ab-12 ', email: '  Ada@example.com  ', id: 1, norm: 'é', slug: 'Hello World' },
		]);
		// The STORED value is already rewritten (insert ran schema.parse) — prove it with the raw `query` helper
		// reading plain Strings (no overwrite).
		const stored = await ch.rawSelect(
			z.object({ email: CH.String, code: CH.String, norm: CH.String, slug: CH.String }),
			`SELECT email, code, norm, slug FROM ${OW} WHERE id = 1`
		);
		expect(stored[0]).toEqual({
			code: 'AB-12',
			email: 'ada@example.com',
			norm: 'é',
			slug: 'hello-world',
		});
		expect(stored[0].norm.length).toBe(1); // NFC composed 'é' is a single code unit
		// Reading back through the overwrite schema is idempotent here.
		expect(await ch.select(T, ['id', 'email', 'code', 'norm', 'slug'])).toEqual([
			{ code: 'AB-12', email: 'ada@example.com', id: 1, norm: 'é', slug: 'hello-world' },
		]);
	});

	it('formats (email/url/uuid via top-level z.* + refine) & superRefine', async () => {
		const UUID = '0192c0de-cafe-7000-8000-0123456789ab';
		const T = new ClickHouseTable({
			engine: { kind: 'MergeTree' },
			name: FMT,
			schema: z.object({
				at: CH.String.superRefine((v, ctx) => {
					if (!v.includes('@')) ctx.addIssue({ code: 'custom', message: 'needs @' });
				}),
				// Zod 4: formats are top-level functions (`.email()`/`.url()`/`.uuid()` string methods are
				// deprecated); apply them to a CH primitive via `.refine` so the String wire type is preserved.
				email: CH.String.refine((v) => z.email().safeParse(v).success, 'invalid email'),
				even: CH.String.refine((v) => v.length % 2 === 0, 'must be even length'),
				id: CH.UInt32,
				ref: CH.String.refine((v) => z.uuid().safeParse(v).success, 'invalid uuid'),
				site: CH.String.refine((v) => z.url().safeParse(v).success, 'invalid url'),
			}),
		});
		const valid = {
			at: 'x@y',
			email: 'ada@example.com',
			even: 'abcd',
			id: 1,
			ref: UUID,
			site: 'https://example.com',
		};
		await ch.insert(FMT, T.schema, [valid]);
		expect(await ch.select(T, ['id', 'email', 'site', 'ref', 'even', 'at'])).toEqual([valid]);
		await expect(ch.insert(FMT, T.schema, [{ ...valid, email: 'nope', id: 2 }])).rejects.toThrow(); // email
		await expect(
			ch.insert(FMT, T.schema, [{ ...valid, id: 2, site: 'not a url' }])
		).rejects.toThrow(); // url
		await expect(
			ch.insert(FMT, T.schema, [{ ...valid, id: 2, ref: 'not-a-uuid' }])
		).rejects.toThrow(); // uuid
		await expect(ch.insert(FMT, T.schema, [{ ...valid, even: 'abc', id: 2 }])).rejects.toThrow(); // refine
		await expect(ch.insert(FMT, T.schema, [{ ...valid, at: 'xy', id: 2 }])).rejects.toThrow(); // superRefine
	});
});
