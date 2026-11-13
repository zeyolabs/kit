import { describe, expect, it } from 'vitest';

import { Cron } from './cron';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();
/** Next fire after `after` as an ISO string. */
const next = (expr: string, tz: string, after: string) => iso(Cron.next(expr, tz, at(after)));

describe('Cron.next basics', () => {
	it('finds the next minute, hour and day', () => {
		expect(next('* * * * *', 'UTC', '2026-11-13T10:00:00Z')).toBe('2026-11-13T10:01:00.000Z');
		expect(next('30 * * * *', 'UTC', '2026-11-13T10:30:00Z')).toBe('2026-11-13T11:30:00.000Z');
		expect(next('0 9 * * *', 'UTC', '2026-11-13T09:00:00Z')).toBe('2026-11-14T09:00:00.000Z');
		expect(next('0 9 * * *', 'UTC', '2026-11-13T08:59:59Z')).toBe('2026-11-13T09:00:00.000Z');
	});

	it('is strictly after, ignores seconds and accepts a Date', () => {
		expect(next('*/5 * * * *', 'UTC', '2026-11-13T10:05:00Z')).toBe('2026-11-13T10:10:00.000Z');
		expect(next('*/5 * * * *', 'UTC', '2026-11-13T10:04:59.999Z')).toBe('2026-11-13T10:05:00.000Z');
		expect(Cron.next('0 0 * * *', 'UTC', new Date('2026-11-13T12:00:00Z'))).toBe(
			at('2026-11-14T00:00:00Z')
		);
	});

	it('defaults to UTC and now', () => {
		expect(Cron.next('* * * * *')).toBeGreaterThan(Date.now());
		expect(next('0 12 * * *', 'UTC', '2026-01-01T00:00:00Z')).toBe('2026-01-01T12:00:00.000Z');
	});

	it('supports lists, ranges and steps', () => {
		expect(next('0,30 9-10 * * *', 'UTC', '2026-11-13T09:30:00Z')).toBe('2026-11-13T10:00:00.000Z');
		expect(next('0-20/10 * * * *', 'UTC', '2026-11-13T10:10:00Z')).toBe('2026-11-13T10:20:00.000Z');
		expect(next('45/10 * * * *', 'UTC', '2026-11-13T10:45:00Z')).toBe('2026-11-13T10:55:00.000Z');
		expect(next('*/20 * * * *', 'UTC', '2026-11-13T10:40:00Z')).toBe('2026-11-13T11:00:00.000Z');
	});

	it('supports month and day names in any case', () => {
		expect(next('0 9 1 JAN *', 'UTC', '2026-11-13T00:00:00Z')).toBe('2027-01-01T09:00:00.000Z');
		expect(next('0 9 * * Mon-Fri', 'UTC', '2026-11-13T10:00:00Z')).toBe('2026-11-16T09:00:00.000Z');
		expect(next('0 9 * * sat,sun', 'UTC', '2026-11-13T10:00:00Z')).toBe('2026-11-14T09:00:00.000Z');
	});

	it('treats Sunday as 0 or 7', () => {
		// 2026-11-15 is a Sunday.
		expect(next('0 9 * * 0', 'UTC', '2026-11-13T00:00:00Z')).toBe('2026-11-15T09:00:00.000Z');
		expect(next('0 9 * * 7', 'UTC', '2026-11-13T00:00:00Z')).toBe('2026-11-15T09:00:00.000Z');
		expect(next('0 9 * * 5-7', 'UTC', '2026-11-13T10:00:00Z')).toBe('2026-11-14T09:00:00.000Z');
		expect(next('0 9 * * 1-5', 'UTC', '2026-11-13T10:00:00Z')).toBe('2026-11-16T09:00:00.000Z');
	});

	it('matches either day field when both are restricted, both otherwise', () => {
		// 13th of the month OR Monday: Friday 2026-11-13 qualifies.
		expect(next('0 9 13 * 1', 'UTC', '2026-11-12T10:00:00Z')).toBe('2026-11-13T09:00:00.000Z');
		// Day-of-month only: Mondays don't count.
		expect(next('0 9 13 * *', 'UTC', '2026-11-12T10:00:00Z')).toBe('2026-11-13T09:00:00.000Z');
		// `*/2` day-of-month counts as unrestricted, so it must also be a Monday: 2026-11-09 is
		// the first odd Monday after the 3rd.
		expect(next('0 9 */2 * 1', 'UTC', '2026-11-04T00:00:00Z')).toBe('2026-11-09T09:00:00.000Z');
	});
});

describe('Cron.next month ends and years', () => {
	it('handles the 31st and short months', () => {
		expect(next('0 0 31 * *', 'UTC', '2026-01-31T00:00:00Z')).toBe('2026-03-31T00:00:00.000Z');
		expect(next('0 0 31 * *', 'UTC', '2026-04-01T00:00:00Z')).toBe('2026-05-31T00:00:00.000Z');
		expect(next('0 0 30 * *', 'UTC', '2026-01-30T00:00:00Z')).toBe('2026-03-30T00:00:00.000Z');
	});

	it('rolls over year ends', () => {
		expect(next('0 0 * * *', 'UTC', '2026-12-31T00:00:00Z')).toBe('2027-01-01T00:00:00.000Z');
		expect(next('59 23 31 12 *', 'UTC', '2026-12-31T23:59:00Z')).toBe('2027-12-31T23:59:00.000Z');
	});

	it('finds leap days, even years away', () => {
		expect(next('0 0 29 2 *', 'UTC', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
		expect(next('0 0 29 2 *', 'UTC', '2096-03-01T00:00:00Z')).toBe('2104-02-29T00:00:00.000Z');
	});

	it('throws for a schedule that never fires', () => {
		expect(() => Cron.next('0 0 31 2 *', 'UTC', at('2026-01-01T00:00:00Z'))).toThrow('never fires');
	});
});

describe('Cron.next timezones and daylight saving', () => {
	it('uses the wall clock of the timezone', () => {
		// London is UTC+1 in summer, UTC+0 in winter.
		expect(next('0 9 * * *', 'Europe/London', '2026-07-01T00:00:00Z')).toBe(
			'2026-07-01T08:00:00.000Z'
		);
		expect(next('0 9 * * *', 'Europe/London', '2026-12-01T00:00:00Z')).toBe(
			'2026-12-01T09:00:00.000Z'
		);
		expect(next('0 9 * * *', 'Asia/Tokyo', '2026-11-30T12:00:00Z')).toBe(
			'2026-12-01T00:00:00.000Z'
		);
		expect(next('30 9 * * *', 'Asia/Kolkata', '2026-12-01T00:00:00Z')).toBe(
			'2026-12-01T04:00:00.000Z'
		);
	});

	it('keeps the local hour across spring forward (London, 29 Mar 2026)', () => {
		expect(next('0 9 * * *', 'Europe/London', '2026-03-28T10:00:00Z')).toBe(
			'2026-03-29T08:00:00.000Z'
		);
		expect(next('0 9 * * *', 'Europe/London', '2026-03-29T08:00:00Z')).toBe(
			'2026-03-30T08:00:00.000Z'
		);
	});

	it('keeps the local hour across fall back (London, 25 Oct 2026)', () => {
		expect(next('0 9 * * *', 'Europe/London', '2026-10-24T09:00:00Z')).toBe(
			'2026-10-25T09:00:00.000Z'
		);
		expect(next('0 9 * * *', 'Europe/London', '2026-10-25T09:00:00Z')).toBe(
			'2026-10-26T09:00:00.000Z'
		);
	});

	it('runs a time skipped by spring forward once, shifted past the jump', () => {
		// London 01:30 does not exist on 29 Mar 2026 (01:00 GMT jumps to 02:00 BST): fires at 02:30 BST.
		expect(next('30 1 * * *', 'Europe/London', '2026-03-28T12:00:00Z')).toBe(
			'2026-03-29T01:30:00.000Z'
		);
		expect(next('30 1 * * *', 'Europe/London', '2026-03-29T01:30:00Z')).toBe(
			'2026-03-30T00:30:00.000Z'
		);
		// New York: 02:30 skipped on 8 Mar 2026 (clocks 02:00 to 03:00 EST to EDT), runs once at 03:30 EDT.
		expect(next('30 2 * * *', 'America/New_York', '2026-03-07T12:00:00Z')).toBe(
			'2026-03-08T07:30:00.000Z'
		);
		expect(next('30 2 * * *', 'America/New_York', '2026-03-08T07:30:00Z')).toBe(
			'2026-03-09T06:30:00.000Z'
		);
	});

	it('runs a time repeated by fall back once, at its first occurrence', () => {
		// London 01:30 happens at 00:30Z (BST) and 01:30Z (GMT) on 25 Oct 2026.
		expect(next('30 1 * * *', 'Europe/London', '2026-10-24T12:00:00Z')).toBe(
			'2026-10-25T00:30:00.000Z'
		);
		expect(next('30 1 * * *', 'Europe/London', '2026-10-25T00:30:00Z')).toBe(
			'2026-10-26T01:30:00.000Z'
		);
	});

	it('steps through an hourly schedule across the changes without going backwards', () => {
		let t = at('2026-03-29T00:00:00Z');
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			t = Cron.next('0 * * * *', 'Europe/London', t);
			seen.push(iso(t));
		}
		expect(seen).toEqual([
			'2026-03-29T01:00:00.000Z',
			'2026-03-29T02:00:00.000Z',
			'2026-03-29T03:00:00.000Z',
			'2026-03-29T04:00:00.000Z',
		]);
		let u = at('2026-10-24T22:30:00Z');
		for (let i = 0; i < 6; i++) {
			const following = Cron.next('0 * * * *', 'Europe/London', u);
			expect(following).toBeGreaterThan(u);
			u = following;
		}
	});

	it('handles half-hour offsets and the southern hemisphere', () => {
		// Sydney ends daylight saving on 4 Apr 2027 (03:00 AEDT back to 02:00 AEST): 25 hours between 09:00s.
		expect(next('0 9 * * *', 'Australia/Sydney', '2027-04-02T00:00:00Z')).toBe(
			'2027-04-02T22:00:00.000Z'
		);
		expect(next('0 9 * * *', 'Australia/Sydney', '2027-04-02T22:00:00Z')).toBe(
			'2027-04-03T23:00:00.000Z'
		);
	});
});

describe('Cron.validate and errors', () => {
	it('accepts good schedules', () => {
		expect(Cron.validate('*/5 * * * *')).toBeNull();
		expect(Cron.validate('0 9 * * mon-fri', 'Europe/London')).toBeNull();
		expect(Cron.validate('  0   9 * * 1  ')).toBeNull();
		expect(Cron.validate('0 0 29 2 *')).toBeNull();
	});

	it.each([
		['', '5 fields'],
		['* * * *', '5 fields'],
		['* * * * * *', '5 fields'],
		['60 * * * *', 'outside 0-59'],
		['* 24 * * *', 'outside 0-23'],
		['* * 0 * *', 'outside 1-31'],
		['* * * 13 *', 'outside 1-12'],
		['* * * * 8', 'outside 0-7'],
		['5-1 * * * *', 'outside'],
		['*/0 * * * *', 'step'],
		['*/x * * * *', 'step'],
		['*/ * * * *', 'not valid'],
		['1//2 * * * *', 'not valid'],
		['a * * * *', 'not a number or name'],
		['* * * foo *', 'not a number or name'],
		['1-2-3 * * * *', 'not valid'],
		['1,,2 * * * *', 'not valid'],
		['0 0 31 2 *', 'never fires'],
		['0 0 31 4,6,9,11 *', 'never fires'],
	])('rejects %j', (expr, message) => {
		expect(Cron.validate(expr)).toContain(message);
		expect(() => Cron.next(expr, 'UTC', 0)).toThrow(message);
	});

	it('rejects an unknown timezone', () => {
		expect(Cron.validate('* * * * *', 'Mars/Olympus')).toContain('not a timezone');
		expect(() => Cron.next('* * * * *', 'Mars/Olympus', 0)).toThrow('not a timezone');
	});
});
