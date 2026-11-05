import type { Reader } from '@clickhouse/rowbinary';

import { z } from 'zod';

import type { ClickHouseColumn, ColumnNode } from './schema';

import { Datetime } from '../../utils/datetime';
import { AggregateFunctionNativeDecodingError, UndecodableColumnError } from './error';
import { scalarReader } from './readers';

/** Wrap a scalar leaf reader so a `DateTime`/`DateTime64` column surfaces as a domain `ZonedDateTime`,
 *  never a raw epoch number — the CH-boundary conversion the read path owns now that rows are no longer
 *  run through zod. Keyed on the wire type, so it rides through `Nullable`/`Array`/… (the wrappers compose
 *  from this leaf). `Date`/`Date32`/`Time`/`Time64` are NOT instants, so they pass through untouched. */
function dateTimeGuard(ch: string, read: Reader<unknown>): Reader<unknown> {
	if (!ch.startsWith('DateTime')) return read;
	return (cursor) => Datetime.zonedFromUnixSeconds(read(cursor) as number);
}

/** Compile a read schema into its columns (in field order). Each column pairs the derived CH wire type
 *  (the drift-guard key) with its compiled decode tree. A PURE builder — no memoization here; callers
 *  cache the result on the long-lived `ClickHouseTable` (per-column at construction + per query). */
export function compileSchema(schema: z.ZodObject): ClickHouseColumn[] {
	return Object.entries(schema.shape).map(([name, zodType]) => {
		const { node, type } = compileColumn(zodType as z.core.$ZodType);
		return { decodeTree: node, name, type };
	});
}

/** One walk of a zod field → its full CH wire type (the drift-guard key) AND its decode tree. A
 *  scalar primitive carries both on its `.meta({ ch, read })`, so its leaf is read directly (no
 *  type-string switch); structural wrappers (Array/Nullable/Tuple/Map) compose from the zod shape,
 *  setting `asMap`/`asSet` inline; a raw `.meta({ ch })` string with no `read` (geo, LowCardinality,
 *  Variant, Nested) is authoritative and parsed by `parseTypeTree`. */
function compileColumn(field: z.core.$ZodType): { node: ColumnNode; type: string } {
	field = unwrapModifiers(field);
	const meta = z.globalRegistry.get(field);
	const ch = meta?.ch;
	if (typeof ch === 'string') {
		const read = meta?.read as Reader<unknown> | undefined;
		if (read) return { node: { kind: 'scalar', read: dateTimeGuard(ch, read) }, type: ch };
		// Raw ch string is authoritative — parse it (geo, LowCardinality, Variant, Nested, …).
		return { node: parseTypeTree(ch), type: ch };
	}
	if (field instanceof z.ZodNullable) {
		const inner = compileColumn(field.unwrap());
		return { node: { inner: inner.node, kind: 'nullable' }, type: `Nullable(${inner.type})` };
	}
	if (field instanceof z.ZodArray) {
		const inner = compileColumn(field.element);
		return { node: { inner: inner.node, kind: 'array' }, type: `Array(${inner.type})` };
	}
	// z.set → JS Set: same Array(...) wire type, flagged so the reader rebuilds a Set.
	if (field instanceof z.ZodSet) {
		const inner = compileColumn(field.def.valueType);
		return {
			node: { asSet: true, inner: inner.node, kind: 'array' },
			type: `Array(${inner.type})`,
		};
	}
	if (field instanceof z.ZodObject) {
		const fields = Object.entries(field.shape).map(([name, value]) => {
			const inner = compileColumn(value as z.core.$ZodType);
			return { name, node: inner.node, type: inner.type };
		});
		return {
			node: {
				fields: fields.map((f) => ({ name: f.name, node: f.node })),
				kind: 'tuple',
				named: true,
			},
			type: `Tuple(${fields.map((f) => `${f.name} ${f.type}`).join(', ')})`,
		};
	}
	if (field instanceof z.ZodTuple) {
		const items = field.def.items.map((item) => compileColumn(item));
		return {
			node: { fields: items.map((i) => ({ node: i.node })), kind: 'tuple', named: false },
			type: `Tuple(${items.map((i) => i.type).join(', ')})`,
		};
	}
	// z.record → Map(...) object; z.map → JS Map, flagged so the reader rebuilds a Map (typed keys).
	if (field instanceof z.ZodRecord) {
		const key = compileColumn(field.keyType);
		const value = compileColumn(field.valueType);
		return {
			node: { key: key.node, kind: 'map', value: value.node },
			type: `Map(${key.type}, ${value.type})`,
		};
	}
	if (field instanceof z.ZodMap) {
		const key = compileColumn(field.keyType);
		const value = compileColumn(field.valueType);
		return {
			node: { asMap: true, key: key.node, kind: 'map', value: value.node },
			type: `Map(${key.type}, ${value.type})`,
		};
	}
	throw new UndecodableColumnError(field);
}

/** Strip zod-only wrappers that leave no trace in the decode tree, exposing the schema the tree was
 *  compiled from (a pipe's CH side is its input schema). */
function unwrapModifiers(field: z.core.$ZodType): z.core.$ZodType {
	for (;;) {
		if (
			field instanceof z.ZodOptional ||
			field instanceof z.ZodNonOptional ||
			field instanceof z.ZodDefault ||
			field instanceof z.ZodPrefault ||
			field instanceof z.ZodCatch ||
			field instanceof z.ZodReadonly ||
			field instanceof z.ZodLazy
		)
			field = field.unwrap();
		else if (field instanceof z.ZodPipe) field = field.def.in;
		else return field;
	}
}

/** The CH wire type on a column's leaf `.meta({ ch })`, or `undefined` if it has none — a bare `z.string()`
 *  insert override, or a structural type with no leaf ch. A lenient, TYPE-ONLY companion to `compileColumn`
 *  (which builds the decode tree and THROWS on an untyped column): callers that only need the wire type — e.g.
 *  `insert` choosing a value's JSON transport form — use this. Unwraps the modifier wrappers + a Nullable. */
export function chTypeOf(field: z.core.$ZodType): string | undefined {
	let f = unwrapModifiers(field);
	if (f instanceof z.ZodNullable) f = unwrapModifiers(f.unwrap());
	const ch = z.globalRegistry.get(f)?.ch;
	return typeof ch === 'string' ? ch : undefined;
}

/** The FULL CH wire type of a field — e.g. `Nullable(DateTime64(3))`, `Array(UInt32)` — i.e. `compileColumn`'s
 *  type side, without building the decode tree it discards. Lets the `CH.Variant`/`CH.Nested` factory helpers
 *  assemble a composite ch string from their inner primitives (which may themselves be wrapped). Throws (like
 *  `compileColumn`) if a field has no derivable wire type. */
export function chWireType(field: z.core.$ZodType): string {
	return compileColumn(field).type;
}

/** Split CH type arguments on top-level commas, ignoring commas nested in parens
 *  (`Tuple(a UInt32, b Map(String, UInt32))` → two args, not three). */
function splitArgs(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;
	let inQuotes = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		// Track single-quoted literals (e.g. an Enum member name) so a `(` or `,` inside one doesn't
		// desync the paren depth or split mid-name. `\'` is an escaped quote, not a delimiter.
		if (c === "'" && s[i - 1] !== '\\') inQuotes = !inQuotes;
		else if (!inQuotes) {
			if (c === '(') depth++;
			else if (c === ')') depth--;
			else if (c === ',' && depth === 0) {
				out.push(s.slice(start, i).trim());
				start = i + 1;
			}
		}
	}
	out.push(s.slice(start).trim());
	return out;
}

/** Parse a raw CH type STRING into a decode tree — for the `.meta({ ch })` escape leaves (geo,
 *  LowCardinality, Variant, Nested) and `raw()` ad-hoc SQL, where there's no zod leaf carrying a
 *  reader. Done once per column, not per value; scalar leaves resolve through `scalarReader`. */
function parseTypeTree(type: string): ColumnNode {
	type = type.trim(); // tolerate stray whitespace in a hand-written `.meta({ ch })` string
	/** Inner of a `Wrapper(...)` type: strip the named prefix and the closing paren. */
	const arg = (prefix: string) => type.slice(prefix.length, -1).trim();

	// Alias / transparent types recurse on their structural form: geo → Tuple/Array of Float64,
	// SimpleAggregateFunction → its value type, Nested → Array(Tuple(...)).
	if (type === 'Point') return parseTypeTree('Tuple(Float64, Float64)');
	if (type === 'Ring' || type === 'LineString')
		return parseTypeTree('Array(Tuple(Float64, Float64))');
	if (type === 'Polygon' || type === 'MultiLineString')
		return parseTypeTree('Array(Array(Tuple(Float64, Float64)))');
	if (type === 'MultiPolygon') return parseTypeTree('Array(Array(Array(Tuple(Float64, Float64))))');
	if (type.startsWith('SimpleAggregateFunction('))
		return parseTypeTree(splitArgs(arg('SimpleAggregateFunction(')).at(-1)!);
	if (type.startsWith('Nested(')) return parseTypeTree(`Array(Tuple(${arg('Nested(')}))`);

	if (type.startsWith('Tuple(')) {
		const fields = splitArgs(arg('Tuple(')).map((field) => {
			// `name Type` (named) or `Type` (anon); the boundary is the first space before any '('.
			const space = field.indexOf(' ');
			const paren = field.indexOf('(');
			const named = space > 0 && (paren < 0 || space < paren);
			return {
				name: named ? field.slice(0, space) : undefined,
				node: parseTypeTree(named ? field.slice(space + 1) : field),
			};
		});
		return { fields, kind: 'tuple', named: fields.every((f) => f.name !== undefined) };
	}
	if (type.startsWith('Map(')) {
		const [key, value] = splitArgs(arg('Map('));
		return { key: parseTypeTree(key), kind: 'map', value: parseTypeTree(value) };
	}
	if (type.startsWith('Variant('))
		return { kind: 'variant', variants: splitArgs(arg('Variant(')).map(parseTypeTree) };
	if (type.startsWith('AggregateFunction(')) throw new AggregateFunctionNativeDecodingError(type);
	if (type.startsWith('Nullable('))
		return { inner: parseTypeTree(arg('Nullable(')), kind: 'nullable' };
	if (type.startsWith('Array(')) return { inner: parseTypeTree(arg('Array(')), kind: 'array' };
	if (type.startsWith('LowCardinality(')) {
		const inner = arg('LowCardinality(');
		const nullable = inner.startsWith('Nullable(');
		return {
			inner: parseTypeTree(nullable ? inner.slice('Nullable('.length, -1).trim() : inner),
			kind: 'lowCardinality',
			nullable,
		};
	}
	return { kind: 'scalar', read: dateTimeGuard(type, scalarReader(type)) };
}
