import {
	type CalendarDate,
	DateFormatter,
	fromDate,
	getDayOfWeek,
	getLocalTimeZone,
	now,
	parseDate,
	type Time,
	toCalendarDate,
	today,
	toTime,
	toZoned,
	type ZonedDateTime,
} from '@internationalized/date';

const DEFAULT_LOCALE = 'en-GB';

// Day of the week

export const Days = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday',
] as const;
export type Day = (typeof Days)[number];

export const DayIndex: Record<Day, number> = Object.fromEntries(
	Days.map((day, index) => [day, index])
) as Record<Day, number>;

// Date functions local to a timezone
export class LocalDateF {
	constructor(private readonly timezone: string) {}

	/** @returns The current date and time. */
	now(): ZonedDateTime {
		return now(this.timezone);
	}

	/** @returns The current date. */
	today(): CalendarDate {
		return today(this.timezone);
	}
}

export const SERVER_TIME_ZONE = 'Europe/London';
export const SERVER_LOCALE = 'en-GB';

// Date functions local to server time zone
export const ServerDt = new LocalDateF(SERVER_TIME_ZONE);

/** Gets the day index of the date */
function getDayIndexOfDate(date: CalendarDate): number {
	// Always start 0 on Monday
	return getDayOfWeek(date, DEFAULT_LOCALE, 'mon');
}

/**
 * Gets the day of the week for a given date.
 * @param date - The date to get the day of the week for.
 * @returns The day of the week
 */
function getDayOfDate(date: CalendarDate): Day {
	return Days[getDayIndexOfDate(date)];
}

/* Formatting */

/* Day of the week */

/**
 * Formats a day of the week.
 * @param day - The day of the week to format.
 * @example "Monday" -> "Mon"
 * @returns Formatted string of the day of the week.
 */
function formatDayShort(day: Day): string {
	// Use the first three letters of the day
	return day.slice(0, 3);
}

/* Calendar Dates */

const FullDateFormatter = new DateFormatter(DEFAULT_LOCALE, {
	day: 'numeric',
	month: 'short',
	year: 'numeric',
});

const ShortDateFormatter = new DateFormatter(DEFAULT_LOCALE, {
	day: 'numeric',
	month: 'short',
});

const NumFormatter = new DateFormatter(DEFAULT_LOCALE, {
	day: '2-digit',
	month: '2-digit',
	year: 'numeric',
});

/**
 * @param date The CalendarDate object to format.
 * @returns The formatted date string in dd/mm/yyyy format.
 * @example "05/10/2023"
 */
function formatDateNum(date: CalendarDate): string {
	return formatDate(date, NumFormatter);
}

/**
 * Formats a full date and time.
 * @param datetime The ZonedDateTime object to format.
 * @returns The formatted date and time string.
 * @example "05/10/2023 14:30:00"
 */
function formatAbsolute(datetime: ZonedDateTime): string {
	const date = toCalendarDate(datetime);
	const time = toTime(datetime);
	return `${formatDateNum(date)} ${formatTimeFull(time)}`;
}

/**
 * @param date The CalendarDate object to format.
 * @returns The formatted date string.
 * @example "5 Oct 2023"
 */
function formatDateFull(date: CalendarDate) {
	return formatDate(date, FullDateFormatter);
}

/**
 * ISO format
 * @param date The CalendarDate object to format.
 * @returns The formatted date string in YYYY-MM-DD format.
 * @example "2023-10-05"
 */
function formatDateISO(date: CalendarDate): string {
	return date.toString();
}

/**
 * @param date The CalendarDate object to format.
 * @returns string of date in shortened format
 * @example "Oct 5"
 */
function formatDateShort(date: CalendarDate) {
	return formatDate(date, ShortDateFormatter);
}

/* Times */

/**
 * Gives time in HH:MM format
 * @param time
 * @returns string of time in that format
 */
function formatTime(time: Time): string {
	const hours = padNum(time.hour, 2);
	const minutes = padNum(time.minute, 2);
	return `${hours}:${minutes}`;
}

/**
 * Gives time in HH:MM:SS format
 * @param time
 * @returns string of time in that format
 */
function formatTimeFull(time: Time): string {
	const hours = padNum(time.hour, 2);
	const minutes = padNum(time.minute, 2);
	const seconds = padNum(time.second, 2);
	return `${hours}:${minutes}:${seconds}`;
}

/* Helpers */

function formatDate(date: CalendarDate, formatter: DateFormatter): string {
	const nativeDate = date.toDate(getLocalTimeZone());
	return formatter.format(nativeDate);
}

function padNum(num: number, len: number): string {
	if (isNaN(num)) return '0'.repeat(len);

	return num.toString().padStart(len, '0');
}

// An absolute instant re-zoned into a viewer's timezone. Without `timezone`, call from client
// code only: `getLocalTimeZone()` reads the current runtime's zone, so server-side it resolves to
// the server zone. The apps that display these are `ssr: false`, so that default always runs in
// the browser. Server-rendered content with no browser to detect from (e.g. an email) must pass
// the viewer's stored `user.timezone` explicitly.
const inViewerZone = (zdt: ZonedDateTime, timezone?: string): ZonedDateTime =>
	fromDate(zdt.toDate(), timezone ?? getLocalTimeZone());

/** HH:MM in the viewer's timezone (stored `timezone`, else the browser's local zone). */
const formatLocalTime = (zdt: ZonedDateTime, timezone?: string): string =>
	formatTime(toTime(inViewerZone(zdt, timezone)));

/** Full date (e.g. "5 Oct 2023") in the viewer's timezone (stored `timezone`, else the browser's local zone). */
const formatLocalDateFull = (zdt: ZonedDateTime, timezone?: string): string =>
	formatDateFull(toCalendarDate(inViewerZone(zdt, timezone)));

/** Numeric date (dd/mm/yyyy) in the viewer's local timezone. */
const formatLocalDateNum = (zdt: ZonedDateTime): string =>
	formatDateNum(toCalendarDate(inViewerZone(zdt)));

/** Numeric date + HH:MM:SS (e.g. "05/10/2023 14:30:00") in the viewer's timezone (stored
 *  `timezone`, else the browser's local zone). */
const formatLocalDateTime = (zdt: ZonedDateTime, timezone?: string): string =>
	formatAbsolute(inViewerZone(zdt, timezone));

/** Whole days from `zdt` (a past instant) to today, in the viewer's timezone (clamped ≥ 0). */
const daysSince = (zdt: ZonedDateTime): number =>
	Math.max(0, today(getLocalTimeZone()).compare(toCalendarDate(inViewerZone(zdt))));

/** Whole days from today to `zdt` (a future instant), in the viewer's timezone (clamped ≥ 0). */
const daysUntil = (zdt: ZonedDateTime): number =>
	Math.max(0, toCalendarDate(inViewerZone(zdt)).compare(today(getLocalTimeZone())));

/** Full local date + whole days since the instant, for a "started/created on {date} · {daysAgo}d ago" UI. */
const formatDateWithDaysAgo = (zdt: ZonedDateTime): { date: string; daysAgo: number } => ({
	date: formatLocalDateFull(zdt),
	daysAgo: daysSince(zdt),
});

/** `from`, pulled forward so the inclusive `from`→`to` range spans at most `maxDays` days.
 *  A range already within the limit comes back unchanged. */
const clampSpanStart = (from: CalendarDate, to: CalendarDate, maxDays: number): CalendarDate =>
	to.compare(from) > maxDays ? to.subtract({ days: maxDays }) : from;

/** Short weekday label for a date, e.g. "Mon". */
const weekdayShort = (date: CalendarDate): string => formatDayShort(getDayOfDate(date));

/** A CalendarDate as a short weekday + day-of-month, e.g. "Mon 31". */
const formatWeekdayDay = (date: CalendarDate): string => `${weekdayShort(date)} ${date.day}`;

/** A ClickHouse DateTime, returned as epoch seconds (the `unix_timestamp` output format), as a ZonedDateTime. */
const zonedFromUnixSeconds = (seconds: number): ZonedDateTime =>
	fromDate(new Date(seconds * 1000), SERVER_TIME_ZONE);

/** A raw Postgres `timestamptz` string, as returned by a raw `ctx.db.execute(sql\`...\`)` select
 *  (bypassing the `absoluteDateTime` custom type's own driver conversion), as a ZonedDateTime. */
const zonedFromPgTimestamp = (s: string): ZonedDateTime => fromDate(new Date(s), SERVER_TIME_ZONE);

/** Domain → wire: a ZonedDateTime as epoch seconds, for CH inserts / query params only. */
const toUnixSeconds = (zdt: ZonedDateTime): number => Math.floor(zdt.toDate().getTime() / 1000);

/** Domain → wire: a CalendarDate at server-tz start-of-day, as epoch seconds (CH DateTime query param). */
const dayStartUnix = (date: CalendarDate): number => toUnixSeconds(toZoned(date, SERVER_TIME_ZONE));

/** Epoch milliseconds (e.g. Gmail `internalDate`) as a ZonedDateTime. */
const zonedFromUnixMillis = (millis: number): ZonedDateTime =>
	fromDate(new Date(millis), SERVER_TIME_ZONE);

/** Domain → wire: a ZonedDateTime as epoch milliseconds (e.g. an HTTP JSON boundary). */
const toUnixMillis = (zdt: ZonedDateTime): number => zdt.toDate().getTime();

/**
 * A ClickHouse `Date` column ("YYYY-MM-DD") as a CalendarDate. Null/empty and the `1970-01-01`
 * zero-date sentinel (CH's null-Date placeholder) map to `null`.
 */
const calendarFromChDate = (s: null | string | undefined): CalendarDate | null =>
	s && s !== '1970-01-01' ? parseDate(s) : null;

/**
 * Compact, human relative time for a **past** instant, rendered in the viewer's timezone:
 * "Just now" (< 1 min), "5m" (< 1 h), "3h" (< 1 day), "Yesterday" (exactly 1 day), then "4d".
 * Elapsed time is the absolute now→`zdt` gap, so the result is timezone-independent.
 */
const formatRelativeShort = (zdt: ZonedDateTime): string => {
	const minutes = Math.floor(now(getLocalTimeZone()).compare(zdt) / 60_000);
	if (minutes < 1) return 'Just now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'Yesterday';
	return `${days}d`;
};

/**
 * Full-word relative time for a **past** instant: "Just now" (< 1 min), "5 minutes ago",
 * "1 hour ago", "10 hours ago", "3 days ago"; 30 days or more falls back to the full local date.
 * Elapsed time is the absolute gap, so the result is timezone-independent. `from` is the "now"
 * to measure against (injectable for tests).
 */
const formatRelativeAgo = (
	zdt: ZonedDateTime,
	from: ZonedDateTime = now(getLocalTimeZone())
): string => {
	const minutes = Math.floor(from.compare(zdt) / 60_000);
	if (minutes < 1) return 'Just now';
	if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
	return formatLocalDateFull(zdt);
};

/** Date/time formatting + wire-format conversion — a plain object of functions (a Library, same
 *  pattern as `Crypto`/`Schema`/`Normalize`), not a service: pure functions, no I/O. `ServerDt`
 *  (above) is a tiny library of its own already — `now()`/`today()` in the server timezone —
 *  so it stays a standalone export rather than folding in here. */
export const Datetime = {
	calendarFromChDate,
	clampSpanStart,
	daysSince,
	dayStartUnix,
	daysUntil,
	formatAbsolute,
	formatDateFull,
	formatDateISO,
	formatDateShort,
	formatDateWithDaysAgo,
	formatDayShort,
	formatLocalDateFull,
	formatLocalDateNum,
	formatLocalDateTime,
	formatLocalTime,
	formatRelativeAgo,
	formatRelativeShort,
	formatTime,
	formatWeekdayDay,
	getDayOfDate,
	toUnixMillis,
	toUnixSeconds,
	weekdayShort,
	zonedFromPgTimestamp,
	zonedFromUnixMillis,
	zonedFromUnixSeconds,
};
