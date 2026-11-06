import {
	CalendarDate as calendarImport,
	parseDate,
	parseTime,
	Time as timeImport,
	ZonedDateTime,
} from '@internationalized/date';
import { z } from 'zod';

import { Datetime, Days } from './datetime';
import { Normalize, titleCase } from './strings/normalize';

const NAME_MAX = 50;

const uuid = z.uuid();

const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

function normalizeSlug(input: string): string {
	return input
		.trim()
		.toLowerCase()
		.replace(/^\/+/, '') // remove leading slashes
		.replace(/\/+$/, ''); // remove trailing slashes
}

const slug = z
	.string()
	.min(1)
	.transform(normalizeSlug)
	.refine((s) => !s.includes('/'), { message: 'Slug must not contain slashes' })
	.refine((s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s), { message: 'Invalid slug format' });

/** Reusable zod primitives — a plain object of schemas/functions (a Library, same pattern as
 *  `Crypto`), not a service: nothing here reads a binding or holds state. */
export const Schema = {
	// Phone: allows "+", digits, and spaces only
	Phone: z
		.string()
		.regex(/^[+0-9 ]+$/, 'invalid phone number. Only +, digits, and spaces are allowed.'),

	/** 6-digit hex color string (without leading `#`) */
	HexColor: z
		.string({ error: 'please pick a color' })
		.regex(/^[0-9a-fA-F]{6}$/, 'invalid hex color, expected RRGGBB'),

	// Datetime types

	Day: z.enum(Days),

	Time: z.instanceof(timeImport, { error: 'invalid time' }),

	CalendarDate: z.instanceof(calendarImport, { error: 'invalid date' }),

	/** ISO 8601 date string ("YYYY-MM-DD") parsed to a `CalendarDate` — the wire-string sibling of
	 *  `CalendarDate` above (which validates an already-decoded instance). */
	DateFromString: z.string().transform((text, ctx) => {
		try {
			return parseDate(text);
		} catch {
			ctx.issues.push({
				code: 'invalid_format',
				format: 'date',
				input: text,
				message: 'invalid date format, expected YYYY-MM-DD',
			});
			return z.NEVER;
		}
	}),

	/** ISO 8601 time string ("HH:mm") parsed to a `Time` — the wire-string sibling of `Time` above. */
	TimeFromString: z.string().transform((text, ctx) => {
		try {
			return parseTime(text);
		} catch {
			ctx.issues.push({
				code: 'invalid_format',
				format: 'time',
				input: text,
				message: 'invalid time format, expected HH:mm',
			});
			return z.NEVER;
		}
	}),

	/** The one domain datetime type: a value is ALWAYS a ZonedDateTime. This schema just accepts
	 *  the two wire forms it can arrive in — an already-decoded ZonedDateTime (transport) or a
	 *  ClickHouse `unix_timestamp` epoch (a number, or a quoted string depending on server
	 *  settings) — and yields a ZonedDateTime either way. */
	ZonedDateTime: z.union([
		z.instanceof(ZonedDateTime),
		z.coerce.number().transform(Datetime.zonedFromUnixSeconds),
	]),

	/** A `ZonedDateTime` that crosses a serialization boundary (a queue) as unix seconds. */
	ZonedDateTimeWire: z.codec(z.number().int(), z.instanceof(ZonedDateTime), {
		decode: Datetime.zonedFromUnixSeconds,
		encode: Datetime.toUnixSeconds,
	}),

	UUID: uuid,
	UUIDs: z.array(uuid),

	// Positive integer for primary keys — mirrors auto-increment DB ids (>= 1)
	Id: z.number().int().positive(),

	// Like `Id`, but also accepts the non-positive sentinel ids a handful of reserved rows use
	// (e.g. `ORG_ACCOUNT_ID = 0`, `MARKETING_ACCOUNT_ID = -1`) — anywhere a real
	// auto-generated row and a reserved shared row can both appear.
	SignedId: z.number().int(),

	StringId: z.string().min(1),

	// `.trim()` MUST run before the `z.email()` format check, not after: zod validates a schema's
	// own built-in format before any transform chained onto it runs, so `z.email().trim()` would
	// reject padded input outright instead of trimming it.
	Email: z.string().trim().max(100).toLowerCase().pipe(z.email('invalid email address')),

	Emails: z.array(z.email()),

	SearchTerm: z.string().min(2, 'Search term must be at least 2 characters long'),

	/** A person's first/last name — title-cased ("SHELDON" / "mark" → "Sheldon" / "Mark"). Not for
	 *  free text (account/campaign/list names use `Text` instead — title-casing would mangle
	 *  brand names/acronyms). */
	Name: z.string().trim().min(1).max(NAME_MAX).transform(titleCase),

	/** Non-empty text field (trimmed, min 1 character) */
	Text: z.string().trim().min(1, 'text cannot be empty'),

	Domain: z
		.string()
		.min(1)
		.transform(Normalize.domain)
		.refine((domain) => domain !== '', { message: 'Invalid domain' }),

	Slug: slug,

	PaginationSchema: z.object({
		limit: z.number(),
		offset: z.number(),
	}),

	// Direction half of a server-side column sort — pair with a per-view sort-key enum so an
	// unknown column is rejected at the schema boundary instead of reaching the query builder.
	SortDirection: z.enum(SORT_DIRECTIONS),

	/** Requires a non-empty file upload. */
	File: z.instanceof(File).refine((f) => f.size > 0, 'file is required'),

	// Zod utilities

	/** Type string which is trimmed before being validated against `typeTo`. */
	trimTo<T extends z.ZodType<string, string>>(typeTo: T) {
		return z.string().trim().pipe(typeTo);
	},

	/** A fixed-length numeric PIN string (default 6 digits). */
	pin(length = 6) {
		return z.string().regex(new RegExp(`^\\d{${length}}$`), `pin must be ${length} digits`);
	},

	/** Constrained to one of the provided string options. */
	select<T extends readonly [string, ...string[]]>(options: T) {
		return z.enum(options);
	},
};

export type Emails = z.infer<typeof Schema.Emails>;
export type Id = z.infer<typeof Schema.Id>;
export type PaginationSchema = z.infer<typeof Schema.PaginationSchema>;
export type SignedId = z.infer<typeof Schema.SignedId>;
export type Slug = z.infer<typeof Schema.Slug>;
export type UUID = z.infer<typeof Schema.UUID>;
export type UUIDs = z.infer<typeof Schema.UUIDs>;
