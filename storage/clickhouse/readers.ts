import {
	formatDecimal,
	formatIPv4,
	formatIPv6,
	formatUUID,
	readBFloat16,
	readBool,
	readDecimal32,
	readDecimal64,
	readDecimal128,
	readDecimal256,
	readEnum8,
	readEnum16,
	type Reader,
	readFixedString,
	readFloat32,
	readFloat64,
	readInt8,
	readInt16,
	readInt32,
	readInt64,
	readInt128,
	readInt256,
	readIPv4,
	readIPv6,
	readNothing,
	readString,
	readTime,
	readTime64,
	readUInt8,
	readUInt16,
	readUInt32,
	readUInt64,
	readUInt128,
	readUInt256,
	readUUID,
} from '@clickhouse/rowbinary';

import { IntervalColumnUnsupportedError, UnsupportedClickHouseTypeError } from './error';

// The single source of truth for CH scalar type → @clickhouse/rowbinary leaf reader. Two callers:
// the CH primitives in ./schema seed their `.meta({ read })` from it (so the compile path reads the
// reader off the leaf, not a switch), and the compiler's string parser resolves raw-`ch`-string
// escapes (geo leaves, Variant/Nested fields, LowCardinality inner) through it.

/** Resolve a scalar CH type to its @clickhouse/rowbinary leaf reader. */
export function scalarReader(type: string): Reader<unknown> {
	/** Pick the right fixed-width Decimal reader for `Decimal(P,S)` / `Decimal32..256(S)`. */
	function decimalReader(t: string) {
		const m = t.match(/^Decimal(32|64|128|256)?\((\d+)(?:,\s*(\d+))?\)$/);
		if (!m) throw new Error(`Native decode: cannot parse ${t}`);
		if (m[1]) {
			const scale = Number(m[2]);
			if (m[1] === '32') return readDecimal32(scale);
			if (m[1] === '64') return readDecimal64(scale);
			if (m[1] === '128') return readDecimal128(scale);
			return readDecimal256(scale);
		}
		const precision = Number(m[2]);
		const scale = Number(m[3]);
		if (precision <= 9) return readDecimal32(scale);
		if (precision <= 18) return readDecimal64(scale);
		if (precision <= 38) return readDecimal128(scale);
		return readDecimal256(scale);
	}
	/** Map an `Enum8/16('name' = n, ...)` type string to value → name. */
	function parseEnum(t: string): Map<number, string> {
		const names = new Map<number, string>();
		const re = /'((?:[^'\\]|\\.)*)'\s*=\s*(-?\d+)/g;
		let m: null | RegExpExecArray;
		while ((m = re.exec(t)) !== null) names.set(Number(m[2]), m[1]);
		return names;
	}
	switch (type) {
		case 'String':
			return readString;
		case 'UInt8':
			return readUInt8;
		case 'UInt16':
			return readUInt16;
		case 'UInt32':
			return readUInt32;
		case 'UInt64':
			return readUInt64;
		case 'UInt128':
			return readUInt128;
		case 'UInt256':
			return readUInt256;
		case 'Int8':
			return readInt8;
		case 'Int16':
			return readInt16;
		case 'Int32':
			return readInt32;
		case 'Int64':
			return readInt64;
		case 'Int128':
			return readInt128;
		case 'Int256':
			return readInt256;
		case 'Float32':
			return readFloat32;
		case 'Float64':
			return readFloat64;
		case 'Bool':
		case 'Boolean':
			return readBool;
		case 'Date':
			return (s) => new Date(readUInt16(s) * 86_400_000).toISOString().slice(0, 10);
		case 'Date32':
			return (s) => new Date(readInt32(s) * 86_400_000).toISOString().slice(0, 10);
		case 'UUID':
			return (s) => formatUUID(readUUID(s));
		case 'IPv4':
			return (s) => formatIPv4(readIPv4(s));
		case 'IPv6':
			return (s) => formatIPv6(readIPv6(s));
		case 'Time':
			return readTime; // Int32 seconds-of-day
		case 'BFloat16':
			return readBFloat16;
		case 'Nothing':
			return readNothing; // only reachable via a malformed empty Array(Nothing)/Nullable(Nothing)
	}
	if (type.startsWith('FixedString(')) {
		return readFixedString(Number(type.slice('FixedString('.length, -1)));
	}
	if (type.startsWith('Time64')) {
		const p = Number(type.slice('Time64('.length).split(/[,)]/)[0]);
		const reader = readTime64(p);
		const div = 10 ** p;
		return (s) => Number(reader(s)[0]) / div; // fractional seconds-of-day
	}
	if (type.startsWith('Interval')) throw new IntervalColumnUnsupportedError(type);
	// Binary formats ignore date_time_output_format — DateTime is always the raw epoch integer on the
	// wire. Return epoch seconds (Date as 'YYYY-MM-DD'), matching the JSONEachRow path so the row-map
	// conversion to ZonedDateTime/CalendarDate is identical across both formats.
	if (type.startsWith('DateTime64')) {
		// Ticks (Int64) at scale p. Split seconds/fraction via bigint so a ns value (>2^53) doesn't
		// lose precision through Number() before the divide. Yields fractional epoch seconds.
		const div = 10n ** BigInt(Number(type.slice('DateTime64('.length).split(/[,)]/)[0]));
		return (s) => {
			const ticks = readInt64(s);
			return Number(ticks / div) + Number(ticks % div) / Number(div);
		};
	}
	if (type.startsWith('DateTime')) return readUInt32; // epoch seconds
	if (type.startsWith('Enum8(')) {
		const names = parseEnum(type);
		return (s) => {
			const v = readEnum8(s);
			return names.get(v) ?? v;
		};
	}
	if (type.startsWith('Enum16(')) {
		const names = parseEnum(type);
		return (s) => {
			const v = readEnum16(s);
			return names.get(v) ?? v;
		};
	}
	if (type.startsWith('Decimal')) {
		const reader = decimalReader(type);
		return (s) => formatDecimal(reader(s));
	}
	throw new UnsupportedClickHouseTypeError(type);
}
