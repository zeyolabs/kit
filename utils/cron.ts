import { Error400 } from './errors';

/**
 * Pure 5-field cron: `minute hour day-of-month month day-of-week`. Supports `*`, lists (`1,15`),
 * ranges (`1-5`), steps (`0-30/10`, `5/15` = 5 to the end of the field, star-slash-10), month names
 * (`jan`-`dec`) and day names (`sun`-`sat`), and Sunday as 0 or 7. No dependency, no I/O.
 *
 * Times are the wall clock of an IANA timezone, so daylight saving is handled:
 * - A wall time skipped by spring-forward (02:30 when the clocks jump 02:00 to 03:00) runs once,
 *   shifted by the length of the jump (03:30), so the day is never missed.
 * - A wall time repeated by fall-back runs once, at its first occurrence. A job set to every hour
 *   or minute therefore fires once per local wall time, not twice in the repeated hour.
 * - Like vixie-cron, when both day-of-month and day-of-week are restricted (neither starts with
 *   `*`) a day matches if EITHER does; otherwise both must match.
 */

type Field = { any: boolean; values: Set<number> };

type Parsed = {
	dayOfMonth: Field;
	dayOfWeek: Field;
	hours: number[];
	minutes: number[];
	months: Field;
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
/** Far enough for `0 0 29 2 *` (a leap day can be 8 years away across a skipped century year). */
const SEARCH_DAYS = 366 * 9;

const parsedCache = new Map<string, Parsed>();

function parseValue(token: string, names: string[], nameBase: number, label: string): number {
	if (/^\d+$/.test(token)) return Number(token);
	const index = names.indexOf(token.toLowerCase());
	if (index === -1) throw Error400(`Cron ${label}: "${token}" is not a number or name`);
	return index + nameBase;
}

function parseField(
	text: string,
	label: string,
	min: number,
	max: number,
	names: string[] = [],
	nameBase = 0
): Field {
	const values = new Set<number>();
	for (const part of text.split(',')) {
		const [range, stepText, extra] = part.split('/');
		if (!range || extra !== undefined || stepText === '') {
			throw Error400(`Cron ${label}: "${part}" is not valid`);
		}
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1 || !/^\d+$/.test(stepText ?? '1')) {
			throw Error400(`Cron ${label}: step "${stepText}" must be a whole number of 1 or more`);
		}
		let from: number;
		let to: number;
		if (range === '*') {
			from = min;
			to = max;
		} else if (range.includes('-')) {
			const [a, b, more] = range.split('-');
			if (!a || !b || more !== undefined) throw Error400(`Cron ${label}: "${range}" is not valid`);
			from = parseValue(a, names, nameBase, label);
			to = parseValue(b, names, nameBase, label);
		} else {
			from = parseValue(range, names, nameBase, label);
			to = stepText === undefined ? from : max;
		}
		if (from < min || to > max || from > to) {
			throw Error400(`Cron ${label}: "${part}" is outside ${min}-${max}`);
		}
		for (let value = from; value <= to; value += step) values.add(value);
	}
	return { any: text.startsWith('*'), values };
}

function parse(expr: string): Parsed {
	const cached = parsedCache.get(expr);
	if (cached) return cached;
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw Error400('A cron schedule has 5 fields: minute hour day-of-month month day-of-week');
	}
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
	const dow = parseField(dayOfWeek, 'day-of-week', 0, 7, DAYS, 0);
	if (dow.values.delete(7)) dow.values.add(0);
	const parsed: Parsed = {
		dayOfMonth: parseField(dayOfMonth, 'day-of-month', 1, 31),
		dayOfWeek: dow,
		hours: [...parseField(hour, 'hour', 0, 23).values].sort((a, b) => a - b),
		minutes: [...parseField(minute, 'minute', 0, 59).values].sort((a, b) => a - b),
		months: parseField(month, 'month', 1, 12, MONTHS, 1),
	};
	if (parsedCache.size > 200) parsedCache.clear();
	parsedCache.set(expr, parsed);
	return parsed;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
	let found = formatters.get(timeZone);
	if (!found) {
		try {
			found = new Intl.DateTimeFormat('en-US', {
				day: 'numeric',
				hour: 'numeric',
				hourCycle: 'h23',
				minute: 'numeric',
				month: 'numeric',
				second: 'numeric',
				timeZone,
				year: 'numeric',
			});
		} catch {
			throw Error400(`"${timeZone}" is not a timezone (use a name like Europe/London)`);
		}
		formatters.set(timeZone, found);
	}
	return found;
}

/** The wall clock in `timeZone` at `instant`, as if it were UTC (epoch ms). */
function wallClock(instant: number, timeZone: string): number {
	const part: Record<string, number> = {};
	for (const { type, value } of formatter(timeZone).formatToParts(instant)) {
		if (type !== 'literal') part[type] = Number(value);
	}
	return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
}

function offsetAt(instant: number, timeZone: string): number {
	return wallClock(instant, timeZone) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall time (as if UTC) happens: first occurrence if repeated, just after the jump if skipped. */
function instantOfWall(wall: number, timeZone: string): number {
	const before = offsetAt(wall - MS_PER_DAY, timeZone);
	const after = offsetAt(wall + MS_PER_DAY, timeZone);
	let best = Infinity;
	for (const offset of new Set([after, before])) {
		const candidate = wall - offset;
		if (wallClock(candidate, timeZone) === wall) best = Math.min(best, candidate);
	}
	// Skipped by a spring-forward: the old offset lands just after the jump.
	return Number.isFinite(best) ? best : wall - before;
}

function dayMatches(parsed: Parsed, month: number, day: number, weekday: number) {
	if (!parsed.months.values.has(month)) return false;
	const domOk = parsed.dayOfMonth.values.has(day);
	const dowOk = parsed.dayOfWeek.values.has(weekday);
	return parsed.dayOfMonth.any || parsed.dayOfWeek.any ? domOk && dowOk : domOk || dowOk;
}

/**
 * The first time after `after` (epoch ms or Date, default now) that `expr` fires in `timeZone`
 * (default UTC), as epoch ms; always in the future and never `after` itself. Throws a 400 for a
 * bad expression or timezone, and for one that never fires (like `0 0 31 2 *`).
 */
function next(expr: string, timeZone = 'UTC', after: Date | number = Date.now()): number {
	const parsed = parse(expr);
	const start = typeof after === 'number' ? after : after.getTime();
	const startWall = wallClock(start, timeZone);
	const startDay = Math.floor(startWall / MS_PER_DAY) * MS_PER_DAY;
	for (let i = 0; i < SEARCH_DAYS; i++) {
		const dayStart = startDay + i * MS_PER_DAY;
		const date = new Date(dayStart);
		if (
			!dayMatches(
				parsed,
				date.getUTCMonth() + 1,
				date.getUTCDate(),
				date.getUTCDay()
			)
		) {
			continue;
		}
		for (const hour of parsed.hours) {
			for (const minute of parsed.minutes) {
				const instant = instantOfWall(dayStart + (hour * 60 + minute) * MS_PER_MINUTE, timeZone);
				if (instant > start) return instant;
			}
		}
	}
	throw Error400(`"${expr}" never fires`);
}

/** `null` when `expr` (and `timeZone`) are valid, otherwise a message fit to show the user. */
function validate(expr: string, timeZone = 'UTC'): null | string {
	try {
		formatter(timeZone);
		parse(expr);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : 'Not a valid schedule';
	}
}

export const Cron = { next, validate };
