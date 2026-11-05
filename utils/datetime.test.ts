import { CalendarDate, Time, ZonedDateTime } from '@internationalized/date';
import { describe, expect, it } from 'vitest';

import { Datetime } from './datetime';

describe('getDayOfDate', () => {
	it('returns the correct day of the week (0 = Monday)', () => {
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 1))).toBe('Monday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 2))).toBe('Tuesday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 3))).toBe('Wednesday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 4))).toBe('Thursday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 5))).toBe('Friday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 6))).toBe('Saturday');
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 5, 7))).toBe('Sunday');
	});

	it('handles dates across different months and years', () => {
		expect(Datetime.getDayOfDate(new CalendarDate(2023, 12, 25))).toBe('Monday');
		expect(Datetime.getDayOfDate(new CalendarDate(2024, 1, 1))).toBe('Monday');
		expect(Datetime.getDayOfDate(new CalendarDate(2024, 2, 29))).toBe('Thursday');
	});
});

describe('formatDayShort', () => {
	it('should format all days of the week correctly', () => {
		expect(Datetime.formatDayShort('Monday')).toBe('Mon');
		expect(Datetime.formatDayShort('Tuesday')).toBe('Tue');
		expect(Datetime.formatDayShort('Wednesday')).toBe('Wed');
		expect(Datetime.formatDayShort('Thursday')).toBe('Thu');
		expect(Datetime.formatDayShort('Friday')).toBe('Fri');
		expect(Datetime.formatDayShort('Saturday')).toBe('Sat');
		expect(Datetime.formatDayShort('Sunday')).toBe('Sun');
	});
});

describe('formatDateShort', () => {
	it('formats date in DD MMM format', () => {
		expect(Datetime.formatDateShort(new CalendarDate(2023, 1, 5))).toBe('5 Jan');
		expect(Datetime.formatDateShort(new CalendarDate(2023, 5, 15))).toBe('15 May');
		expect(Datetime.formatDateShort(new CalendarDate(2023, 12, 25))).toBe('25 Dec');
	});

	it('handles single-digit days correctly', () => {
		expect(Datetime.formatDateShort(new CalendarDate(2023, 7, 1))).toBe('1 Jul');
		expect(Datetime.formatDateShort(new CalendarDate(2023, 9, 9))).toBe('9 Sept');
	});

	it('formats February correctly', () => {
		expect(Datetime.formatDateShort(new CalendarDate(2023, 2, 14))).toBe('14 Feb');
		expect(Datetime.formatDateShort(new CalendarDate(2024, 2, 29))).toBe('29 Feb'); // Leap year
	});
});

describe('formatDateFull', () => {
	it('formats date in DD MMM YYYY format', () => {
		expect(Datetime.formatDateFull(new CalendarDate(2023, 1, 5))).toBe('5 Jan 2023');
		expect(Datetime.formatDateFull(new CalendarDate(2023, 5, 15))).toBe('15 May 2023');
		expect(Datetime.formatDateFull(new CalendarDate(2023, 12, 25))).toBe('25 Dec 2023');
	});

	it('handles leap year dates correctly', () => {
		expect(Datetime.formatDateFull(new CalendarDate(2024, 2, 29))).toBe('29 Feb 2024');
		expect(Datetime.formatDateFull(new CalendarDate(2020, 2, 29))).toBe('29 Feb 2020');
	});

	it('handles all months correctly', () => {
		expect(Datetime.formatDateFull(new CalendarDate(2023, 1, 15))).toBe('15 Jan 2023');
		expect(Datetime.formatDateFull(new CalendarDate(2023, 9, 15))).toBe('15 Sept 2023');
		expect(Datetime.formatDateFull(new CalendarDate(2023, 12, 15))).toBe('15 Dec 2023');
	});
});

describe('formatDateISO', () => {
	it('formats date in YYYY-MM-DD format', () => {
		expect(Datetime.formatDateISO(new CalendarDate(2023, 1, 5))).toBe('2023-01-05');
		expect(Datetime.formatDateISO(new CalendarDate(2023, 5, 15))).toBe('2023-05-15');
		expect(Datetime.formatDateISO(new CalendarDate(2023, 12, 25))).toBe('2023-12-25');
	});

	it('handles single-digit days/months with zero padding', () => {
		expect(Datetime.formatDateISO(new CalendarDate(2023, 7, 1))).toBe('2023-07-01');
		expect(Datetime.formatDateISO(new CalendarDate(2023, 1, 15))).toBe('2023-01-15');
	});

	it('handles leap year dates correctly', () => {
		expect(Datetime.formatDateISO(new CalendarDate(2024, 2, 29))).toBe('2024-02-29');
		expect(Datetime.formatDateISO(new CalendarDate(2020, 2, 29))).toBe('2020-02-29');
	});
});

describe('formatTime', () => {
	it('should format time correctly with 2-digit hours and 2-digit minutes', () => {
		expect(Datetime.formatTime(new Time(14, 30))).toBe('14:30');
	});

	it('should pad single digit hours and minutes with leading zeros', () => {
		expect(Datetime.formatTime(new Time(9, 45))).toBe('09:45');
		expect(Datetime.formatTime(new Time(1, 7))).toBe('01:07');
	});

	it('should format midnight and end of day correctly', () => {
		expect(Datetime.formatTime(new Time(0, 0))).toBe('00:00');
		expect(Datetime.formatTime(new Time(23, 59))).toBe('23:59');
	});
});

describe('formatAbsolute', () => {
	it('should format a ZonedDateTime correctly', () => {
		const datetime = new ZonedDateTime(2024, 5, 15, 'Europe/London', 0, 14, 30);
		expect(Datetime.formatAbsolute(datetime)).toBe('15/05/2024 14:30:00');
	});

	it('should handle midnight and end of day correctly', () => {
		const midnight = new ZonedDateTime(2024, 1, 1, 'Europe/London', 0, 0, 0);
		expect(Datetime.formatAbsolute(midnight)).toBe('01/01/2024 00:00:00');

		const endOfDay = new ZonedDateTime(2024, 12, 31, 'Europe/London', 0, 23, 59);
		expect(Datetime.formatAbsolute(endOfDay)).toBe('31/12/2024 23:59:00');
	});

	it('should pad single digit days and months', () => {
		const datetime = new ZonedDateTime(2024, 2, 5, 'Europe/London', 0, 9, 7);
		expect(Datetime.formatAbsolute(datetime)).toBe('05/02/2024 09:07:00');
	});

	it('should include seconds in the time portion', () => {
		const datetime = new ZonedDateTime(2024, 5, 15, 'Europe/London', 0, 14, 30, 45);
		expect(Datetime.formatAbsolute(datetime)).toBe('15/05/2024 14:30:45');
	});
});

describe('clampSpanStart', () => {
	it('returns the start unchanged when the span is within the limit', () => {
		const from = new CalendarDate(2026, 6, 1);
		const to = new CalendarDate(2026, 8, 27);
		expect(Datetime.clampSpanStart(from, to, 366)).toBe(from);
	});

	it('returns the start unchanged when the span equals the limit exactly', () => {
		const to = new CalendarDate(2026, 8, 27);
		const from = to.subtract({ days: 366 });
		expect(Datetime.clampSpanStart(from, to, 366)).toBe(from);
	});

	it('pulls the start forward when the span exceeds the limit', () => {
		const from = new CalendarDate(2024, 1, 1);
		const to = new CalendarDate(2026, 8, 27);
		const clamped = Datetime.clampSpanStart(from, to, 366);
		expect(to.compare(clamped)).toBe(366);
		expect(Datetime.formatDateISO(clamped)).toBe('2025-08-26');
	});
});

describe('formatRelativeAgo', () => {
	const from = new ZonedDateTime(2026, 10, 1, 'UTC', 0, 12, 0);
	const ago = (d: Parameters<ZonedDateTime['subtract']>[0]) =>
		Datetime.formatRelativeAgo(from.subtract(d), from);

	it('says "Just now" under a minute, and for a clock-skewed future instant', () => {
		expect(ago({ seconds: 20 })).toBe('Just now');
		expect(Datetime.formatRelativeAgo(from.add({ minutes: 5 }), from)).toBe('Just now');
	});

	it('uses whole minutes, with singular/plural', () => {
		expect(ago({ minutes: 1 })).toBe('1 minute ago');
		expect(ago({ minutes: 45 })).toBe('45 minutes ago');
	});

	it('uses whole hours', () => {
		expect(ago({ hours: 1 })).toBe('1 hour ago');
		expect(ago({ hours: 2 })).toBe('2 hours ago');
		expect(ago({ hours: 10 })).toBe('10 hours ago');
		expect(ago({ hours: 23, minutes: 59 })).toBe('23 hours ago');
	});

	it('uses whole days', () => {
		expect(ago({ days: 1 })).toBe('1 day ago');
		expect(ago({ days: 3 })).toBe('3 days ago');
		expect(ago({ days: 29 })).toBe('29 days ago');
	});

	it('falls back to the full local date from 30 days', () => {
		const old = from.subtract({ days: 30 });
		expect(Datetime.formatRelativeAgo(old, from)).toBe(Datetime.formatLocalDateFull(old));
	});
});
