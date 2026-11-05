import {
	Cursor,
	readString,
	readUInt8,
	readUInt16,
	readUInt32,
	readUInt64,
	readUVarint,
} from '@clickhouse/rowbinary';

import type { ClickHouseColumn, ColumnNode, DecodedColumn, NodeKind } from './schema';

/** Decode each Native block against the precompiled columns. Binding is POSITIONAL — the SELECT must
 *  project columns in schema field order — guarded by a name + CH-type assert per column (a mismatch
 *  throws loudly rather than mis-binding). Rows are NOT validated: the client trusts CH and the decode
 *  tree already carries the only boundary transform (DateTime/DateTime64 → ZonedDateTime, in the leaf). */
export function decodeNativeBuffer(
	buf: Buffer,
	columns: ClickHouseColumn[]
): Record<string, unknown>[] {
	const nCols = columns.length;
	const cursor = new Cursor(buf);
	const rows: Record<string, unknown>[] = [];
	while (cursor.pos < buf.length) {
		const blockCols = readUVarint(cursor);
		const nRows = readUVarint(cursor);
		if (blockCols !== nCols)
			throw new Error(`Native decode: schema has ${nCols} columns, block has ${blockCols}`);
		const colArrays = new Array<DecodedColumn>(nCols);
		// CH is a columnar DBMS, data is stored per-column, NOT per-row
		for (let colIndex = 0; colIndex < nCols; colIndex++) {
			const name = readString(cursor);
			const chType = readString(cursor);
			const col = columns[colIndex];
			if (name !== col.name)
				throw new Error(
					`Native decode: column ${colIndex} is '${name}', schema expects '${col.name}'`
				);
			if (chType !== col.type)
				throw new Error(`Native decode: column ${name} wire type ${chType} ≠ schema ${col.type}`);
			colArrays[colIndex] = decodeColumn(cursor, col.decodeTree, nRows);
		}
		for (let rowIndex = 0; rowIndex < nRows; rowIndex++) {
			const row: Record<string, unknown> = {};
			for (let colIndex = 0; colIndex < nCols; colIndex++)
				row[columns[colIndex].name] = colArrays[colIndex][rowIndex];
			rows.push(row);
		}
	}
	return rows;
}

/** Walk a decode tree, decoding `n` column values; each kind's Native framing lives in its decoder. */
function decodeColumn(cursor: Cursor, tree: ColumnNode, n: number): DecodedColumn {
	switch (tree.kind) {
		case 'scalar':
			return decodeScalar(cursor, tree, n);
		case 'nullable':
			return decodeNullable(cursor, tree, n);
		case 'array':
			return decodeArray(cursor, tree, n);
		case 'lowCardinality':
			return decodeLowCardinality(cursor, tree);
		case 'map':
			return decodeMap(cursor, tree, n);
		case 'tuple':
			return decodeTuple(cursor, tree, n);
		case 'variant':
			return decodeVariant(cursor, tree, n);
	}
}

function decodeScalar(cursor: Cursor, node: NodeKind<'scalar'>, n: number): DecodedColumn {
	const out = new Array<unknown>(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) out[rowIndex] = node.read(cursor);
	return out;
}

/** Full null map (one byte per row), then all inner values. */
function decodeNullable(cursor: Cursor, node: NodeKind<'nullable'>, n: number): DecodedColumn {
	const mask = new Uint8Array(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) mask[rowIndex] = readUInt8(cursor);
	const values = decodeColumn(cursor, node.inner, n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) if (mask[rowIndex]) values[rowIndex] = null;
	return values;
}

/** Cumulative u64 offsets, then the flattened elements sliced per row. */
function decodeArray(cursor: Cursor, node: NodeKind<'array'>, n: number): DecodedColumn {
	const offsets = new Array<number>(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) offsets[rowIndex] = Number(readUInt64(cursor));
	const elems = decodeColumn(cursor, node.inner, n > 0 ? offsets[n - 1] : 0);
	const out = new Array<unknown>(n);
	let start = 0;
	for (let rowIndex = 0; rowIndex < n; rowIndex++) {
		const slice = elems.slice(start, offsets[rowIndex]);
		out[rowIndex] = node.asSet ? new Set(slice) : slice; // z.set → JS Set (dedups, drops order)
		start = offsets[rowIndex];
	}
	return out;
}

/** u64 version, u64 index-flags (low byte = index width), u64 dict size, the dict, u64 row count,
 *  then one dict index per row. For Nullable inner, index 0 means NULL. */
function decodeLowCardinality(cursor: Cursor, node: NodeKind<'lowCardinality'>): DecodedColumn {
	readUInt64(cursor); // serialization version (SharedDictionariesWithAdditionalKeys = 1)
	const indexWidth = Number(readUInt64(cursor)) & 0xff;
	const dict = decodeColumn(cursor, node.inner, Number(readUInt64(cursor)));
	const rows = Number(readUInt64(cursor));
	const narrowReader = [readUInt8, readUInt16, readUInt32][indexWidth]; // undefined ⇒ 8-byte index
	const out = new Array<unknown>(rows);
	for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
		const dictIndex = narrowReader ? narrowReader(cursor) : Number(readUInt64(cursor));
		out[rowIndex] = node.nullable && dictIndex === 0 ? null : dict[dictIndex];
	}
	return out;
}

/** Cumulative u64 offsets, then the flat keys column, then the flat values column. */
function decodeMap(cursor: Cursor, node: NodeKind<'map'>, n: number): DecodedColumn {
	const offsets = new Array<number>(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) offsets[rowIndex] = Number(readUInt64(cursor));
	const total = n > 0 ? offsets[n - 1] : 0;
	const keys = decodeColumn(cursor, node.key, total);
	const vals = decodeColumn(cursor, node.value, total);
	const out = new Array<unknown>(n);
	let start = 0;
	for (let rowIndex = 0; rowIndex < n; rowIndex++) {
		if (node.asMap) {
			// z.map → JS Map, preserving typed keys (a number key stays a number, unlike object keys).
			const map = new Map<unknown, unknown>();
			for (let entryIndex = start; entryIndex < offsets[rowIndex]; entryIndex++)
				map.set(keys[entryIndex], vals[entryIndex]);
			out[rowIndex] = map;
		} else {
			const obj: Record<string, unknown> = {};
			for (let entryIndex = start; entryIndex < offsets[rowIndex]; entryIndex++)
				obj[String(keys[entryIndex])] = vals[entryIndex];
			out[rowIndex] = obj;
		}
		start = offsets[rowIndex];
	}
	return out;
}

/** Each element is a full column of n values, laid out one after another. */
function decodeTuple(cursor: Cursor, node: NodeKind<'tuple'>, n: number): DecodedColumn {
	const cols = node.fields.map((field) => decodeColumn(cursor, field.node, n));
	const out = new Array<unknown>(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) {
		if (node.named) {
			const obj: Record<string, unknown> = {};
			for (let fieldIndex = 0; fieldIndex < node.fields.length; fieldIndex++)
				obj[node.fields[fieldIndex].name as string] = cols[fieldIndex][rowIndex];
			out[rowIndex] = obj;
		} else {
			out[rowIndex] = cols.map((fieldValues) => fieldValues[rowIndex]);
		}
	}
	return out;
}

/** u64 discriminator mode (0 = basic), one discriminator byte per row (variant index, or 255 = NULL),
 *  then each variant's values compacted in type order. */
function decodeVariant(cursor: Cursor, node: NodeKind<'variant'>, n: number): DecodedColumn {
	const mode = readUInt64(cursor);
	if (mode !== 0n) throw new Error(`Native decode: Variant compact mode (${mode}) not supported`);
	const discriminators = new Uint8Array(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) discriminators[rowIndex] = readUInt8(cursor);
	const counts = new Array<number>(node.variants.length).fill(0);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) {
		const disc = discriminators[rowIndex];
		if (disc === 255) continue;
		// Guard an out-of-range discriminator with a clear error — otherwise `counts[disc]` is undefined,
		// increments to NaN, and later crashes cryptically on `cols[disc]` in the assembly loop.
		if (disc >= node.variants.length)
			throw new Error(
				`Native decode: Variant discriminator ${disc} out of range (0..${node.variants.length - 1})`
			);
		counts[disc]++;
	}
	const cols = node.variants.map((variantNode, variantIndex) =>
		decodeColumn(cursor, variantNode, counts[variantIndex])
	);
	const positions = new Array<number>(node.variants.length).fill(0);
	const out = new Array<unknown>(n);
	for (let rowIndex = 0; rowIndex < n; rowIndex++) {
		const discriminator = discriminators[rowIndex];
		out[rowIndex] = discriminator === 255 ? null : cols[discriminator][positions[discriminator]++];
	}
	return out;
}
