import type { Reader } from '@clickhouse/rowbinary';

import { ZonedDateTime } from '@internationalized/date';
import { z } from 'zod';

import { Datetime } from '../../utils/datetime';
import { chWireType } from './compiler';
import { scalarReader } from './readers';

/** Per-query ClickHouse settings, passed straight through to the server (e.g. `max_block_size`). */
export type ClickHouseSettings = Record<string, boolean | number | string | undefined>;

/**
 * A compiled decode tree for one column: the CH type parsed once into a tree the decoder walks.
 * `decodeColumn` recurses over this (cheap, tagged dispatch) instead of re-parsing the type string.
 */
export type ColumnNode =
	| { asMap?: boolean; key: ColumnNode; kind: 'map'; value: ColumnNode }
	| { asSet?: boolean; inner: ColumnNode; kind: 'array' }
	| { fields: { name?: string; node: ColumnNode }[]; kind: 'tuple'; named: boolean }
	| { inner: ColumnNode; kind: 'lowCardinality'; nullable: boolean }
	| { inner: ColumnNode; kind: 'nullable' }
	| { kind: 'scalar'; read: Reader<unknown> }
	| { kind: 'variant'; variants: ColumnNode[] };

/** The ColumnNode variant for a given kind — used to type each decoder's `node`. */
export type NodeKind<K extends ColumnNode['kind']> = Extract<ColumnNode, { kind: K }>;

/** A compiled column: its name, its CH wire type (the drift-guard key), and its decode tree. */
export type ClickHouseColumn = { decodeTree: ColumnNode; name: string; type: string };

export type DecodedColumn = unknown[];

/**
 * Read-time engine semantics — how the builder collapses each engine to return final rows. `sortKey` /
 * `version` / `measures` are column names (any CH expression is allowed — they're spliced into the SQL).
 *
 * For the merge engines, a read ALWAYS returns the collapsed state (latest-per-key / summed). For
 * Replacing/Summing, `final` picks the METHOD and is a correctness lever, so it's REQUIRED:
 *   • `final: true`  → `FINAL` — collapses THEN filters (correct when you filter on MUTABLE columns).
 *   • `final: false` → cheaper `LIMIT 1 BY` / `sum()+GROUP BY` — filters THEN collapses (only safe for
 *     filters on the sortKey / immutable columns; a mutable filter can keep a stale-but-matching version).
 * Collapsing/VersionedCollapsing read via the universal `FINAL` (their value columns are real, so FINAL is
 * the correct read). `AggregatingMergeTree` is intentionally absent — its per-column combinator collapse
 * lives in the ORM (see the ch-aggregating-mergetree-debt memory), not this flat client.
 */
export type TableEngine =
	| { final: boolean; kind: 'ReplacingMergeTree'; sortKey: string[]; version?: string }
	| { final: boolean; kind: 'SummingMergeTree'; measures: string[]; sortKey: string[] }
	| { kind: 'CollapsingMergeTree' }
	| { kind: 'MergeTree' }
	| { kind: 'Plain' }
	// Straight-read engines (no merge collapse): Log/TinyLog/StripeLog/Memory/Buffer/Null/Join/View/
	// MaterializedView/Distributed/Merge/File/URL/…
	| { kind: 'VersionedCollapsingMergeTree' };

// The `ClickHouseTable` runtime object lives in ./client (a class that owns its compiled-query cache and
// builds engine-correct SQL); the engine descriptor it consumes — `TableEngine` above — stays here with
// the rest of the wire-type vocabulary.

// ── CH-typed zod primitives (the `CH` factory) ─────────────────────────────────────────────────────
// One namespace of reusable validators, each tagged with its leaf CH wire type via .meta({ ch }) and
// — for scalars — its @clickhouse/rowbinary leaf reader via .meta({ read }), so the decoder reads the
// reader straight off the leaf instead of re-deriving it from a type-string switch. Wrappers compose
// structurally: z.array(CH.UInt32) → Array(UInt32), CH.String.nullable() → Nullable(String), because
// compileColumn derives Array/Nullable/Tuple/Map from the zod structure. Types invisible in zod
// (LowCardinality, geo, and the Enum/Decimal/DateTime params) carry an explicit ch string; the
// non-scalar ones (LowCardinality, geo) omit `read` and are compiled via the string path.

// Builds a scalar CH primitive: a base zod type tagged with its ch wire type + leaf reader.
// Named `scalar` (not `leaf`/`node`) — `node` collides with the decode tree's ColumnNode.
const scalar = <T extends z.ZodType>(base: T, ch: string) =>
	base.meta({ ch, read: scalarReader(ch) });

const enumType = (bits: 8 | 16, members: Record<string, number>) =>
	`Enum${bits}(${Object.entries(members)
		.map(([k, v]) => `'${k}' = ${v}`)
		.join(', ')})`;

export const CH = {
	BFloat16: scalar(z.number(), 'BFloat16'),
	Bool: scalar(z.boolean(), 'Bool'),
	Date: scalar(z.string(), 'Date'),
	Date32: scalar(z.string(), 'Date32'),
	DateTime: scalar(z.number(), 'DateTime'),
	// DateTime64 epoch ↔ ZonedDateTime — the domain always stores instants, so DateTime64 IS zoned (like
	// `ZonedDateTime` for plain DateTime). Reads decode fractional epoch seconds → ZonedDateTime (sub-second
	// kept); the ch + read live on the codec's INPUT scalar (compileColumn unwraps the codec to it).
	DateTime64: (precision: number, tz?: string) =>
		z.codec(
			scalar(z.number(), tz ? `DateTime64(${precision}, '${tz}')` : `DateTime64(${precision})`),
			z.instanceof(ZonedDateTime),
			{
				decode: (epoch) => Datetime.zonedFromUnixSeconds(epoch),
				encode: (zdt) => Datetime.toUnixSeconds(zdt),
			}
		),
	Decimal: (precision: number, scale: number) =>
		scalar(z.string(), `Decimal(${precision}, ${scale})`),
	Enum: (bits: 8 | 16, members: Record<string, number>) =>
		scalar(z.enum(Object.keys(members) as [string, ...string[]]), enumType(bits, members)),
	// Parameterized scalar constructors.
	FixedString: (n: number) => scalar(z.string(), `FixedString(${n})`),
	Float32: scalar(z.number(), 'Float32'),
	Float64: scalar(z.number(), 'Float64'),
	Int128: scalar(z.bigint(), 'Int128'),
	Int16: scalar(z.number(), 'Int16'),
	Int256: scalar(z.bigint(), 'Int256'),
	Int32: scalar(z.number(), 'Int32'),
	Int64: scalar(z.bigint(), 'Int64'),
	Int8: scalar(z.number(), 'Int8'),
	IPv4: scalar(z.string(), 'IPv4'),
	IPv6: scalar(z.string(), 'IPv6'),
	LineString: z.array(z.tuple([z.number(), z.number()])).meta({ ch: 'LineString' }),
	LowCardNullableString: z.string().nullable().meta({ ch: 'LowCardinality(Nullable(String))' }),
	// Non-scalar wrappers carry a raw ch string and no `read` — compiled via the string path.
	LowCardString: z.string().meta({ ch: 'LowCardinality(String)' }),
	MultiLineString: z
		.array(z.array(z.tuple([z.number(), z.number()])))
		.meta({ ch: 'MultiLineString' }),
	MultiPolygon: z
		.array(z.array(z.array(z.tuple([z.number(), z.number()]))))
		.meta({ ch: 'MultiPolygon' }),
	// Nested(name Type, …) — decodes as `Array(Tuple(named …))`, i.e. an array of row-objects. The
	// `z.array(z.object(shape))` validates; the `Nested(…)` ch string drives the decode.
	Nested: <T extends z.ZodRawShape>(shape: T) =>
		z.array(z.object(shape)).meta({
			ch: `Nested(${Object.entries(shape)
				.map(([name, t]) => `${name} ${chWireType(t)}`)
				.join(', ')})`,
		}),
	// Geo types report their own wire name (Point/Ring/…), not the underlying Tuple/Array. A Point is a
	// (Float64, Float64) tuple; each further geo type nests one Array deeper (LineString/Ring share a shape,
	// as do Polygon/MultiLineString — see the decoder's geo cases).
	Point: z.tuple([z.number(), z.number()]).meta({ ch: 'Point' }),
	Polygon: z.array(z.array(z.tuple([z.number(), z.number()]))).meta({ ch: 'Polygon' }),
	Ring: z.array(z.tuple([z.number(), z.number()])).meta({ ch: 'Ring' }),
	String: scalar(z.string(), 'String'),
	Time: scalar(z.number(), 'Time'),
	Time64: (precision: number) => scalar(z.number(), `Time64(${precision})`),
	UInt128: scalar(z.bigint(), 'UInt128'),
	UInt16: scalar(z.number(), 'UInt16'),
	UInt256: scalar(z.bigint(), 'UInt256'),
	UInt32: scalar(z.number(), 'UInt32'),
	UInt64: scalar(z.bigint(), 'UInt64'),
	UInt8: scalar(z.number(), 'UInt8'),
	UUID: scalar(z.string(), 'UUID'),
	// Variant(T1, T2, …) — a column holding one of several types OR NULL (a Variant is implicitly nullable in CH:
	// a row can be "none of the types"), so the validation union includes `z.null()`. The `Variant(…)` ch string
	// (built from each inner's full wire type — inners may themselves be wrapped) drives the decode via the string
	// path (no single leaf reader).
	Variant: <T extends [z.ZodType, z.ZodType, ...z.ZodType[]]>(...inners: T) =>
		z.union([...inners, z.null()]).meta({
			ch: `Variant(${inners.map((i) => chWireType(i)).join(', ')})`,
		}),
	// DateTime epoch ↔ domain instant, a BIDIRECTIONAL codec: `.parse` (read) decodes epoch → ZonedDateTime;
	// `z.encode` (insert) encodes ZonedDateTime → epoch. The ch + read live on the codec's INPUT (the
	// `scalar` DateTime) — `compileColumn` unwraps the codec to its input to drive the wire decode of epoch.
	ZonedDateTime: z.codec(scalar(z.number(), 'DateTime'), z.instanceof(ZonedDateTime), {
		decode: (epoch) => Datetime.zonedFromUnixSeconds(epoch),
		encode: (zdt) => Datetime.toUnixSeconds(zdt),
	}),
} as const;
