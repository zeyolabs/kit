import type { Transport } from '@sveltejs/kit/hooks';

import { CalendarDate, fromDate, Time, ZonedDateTime } from '@internationalized/date';

// Shared SvelteKit universal-hooks transport: encode/decode the `@internationalized/date` types
// so they survive serialization across the load / remote-function boundary. Re-exported from each
// app's `hooks.ts`.
export const transport: Transport = {
	CalendarDate: {
		decode: ([year, month, day]: [number, number, number]) => new CalendarDate(year, month, day),
		encode: (d) => d instanceof CalendarDate && [d.year, d.month, d.day],
	},
	Time: {
		decode: ([hour, minute, second, millisecond]: [number, number, number, number]) =>
			new Time(hour, minute, second, millisecond),
		encode: (t) => t instanceof Time && [t.hour, t.minute, t.second, t.millisecond],
	},
	ZonedDateTime: {
		decode: ([absoluteString, timezone]: [string, string]) => {
			const nativeDate = new Date(absoluteString);
			return fromDate(nativeDate, timezone);
		},
		encode: (value) => value instanceof ZonedDateTime && [value.toAbsoluteString(), value.timeZone],
	},
};
