import { z } from 'zod';

/**
 * An `AggregateFunction()` column holds the aggregate function's own serialized state
 * (function-specific binary blob with NO length prefix, https://clickhouse.com/docs/sql-reference/data-types/aggregatefunction) so there is no generic way to delimit or
 * interpret it without reimplementing each function's deserializer (and trying would desync the rest
 * of the block). Finalize it server-side instead with `finalizeAggregation(col)` or `<func>Merge(col)`
 */
export class AggregateFunctionNativeDecodingError extends Error {
	constructor(type: string) {
		super(
			`Native decode: AggregateFunction state is opaque and not generically decodable (${type})`
		);
		this.name = 'AggregateFunctionNativeDecodingError';
	}
}

/**
 * A ClickHouse wire type with no Native decoder — either genuinely opaque/self-describing (`Dynamic`,
 * `JSON`, `QBit`: variable per-row layouts we don't parse) or simply not implemented yet. To read such
 * a column, project a decodable form in SQL (cast it, extract fields, or `toString()` it).
 */
export class UnsupportedClickHouseTypeError extends Error {
	constructor(type: string) {
		super(`Native decode: unsupported ClickHouse type ${type}`);
		this.name = 'UnsupportedClickHouseTypeError';
	}
}

/**
 * ClickHouse `Interval*` columns aren't decodable here. An Interval is a duration whose meaning depends on
 * its unit (Day/Second/…) and it carries no stable value mapping worth decoding — and CH won't return it
 * from most reads anyway. Store the duration as a plain integer column instead (e.g. `UInt32` of days or
 * `Int64` of seconds) and read that.
 */
export class IntervalColumnUnsupportedError extends Error {
	constructor(type: string) {
		super(
			`Native decode: Interval columns are not supported (${type}) — store the duration as an integer column (e.g. UInt32 days / Int64 seconds) and read that instead`
		);
		this.name = 'IntervalColumnUnsupportedError';
	}
}

/**
 * A column's zod type can't be mapped to a ClickHouse wire type: it carries no `.meta({ ch })` and
 * isn't a structurally-derivable shape. Fixes by case: a bare leaf needs `.meta({ ch: '<type>' })`;
 * `z.intersection` should be one `z.object` (merge with `.extend()`); types with no column meaning
 * (`z.function`, `z.promise`, a `.transform()` whose source carries no `ch`, …) can't be read.
 */
export class UndecodableColumnError extends Error {
	constructor(field: z.core.$ZodType) {
		const kind = field.constructor?.name ?? 'unknown zod type';
		const hint =
			field instanceof z.ZodIntersection
				? ' — merge the schemas into one z.object with .extend()'
				: " — tag it with .meta({ ch: '<ClickHouse type>' })";
		super(`Native decode: cannot derive a ClickHouse type from ${kind}${hint}`);
		this.name = 'UndecodableColumnError';
	}
}
