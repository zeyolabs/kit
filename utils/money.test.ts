import { describe, expect, it } from 'vitest';

import { formatMinorUnits } from './money';

describe('formatMinorUnits', () => {
	it('formats two-decimal currencies from minor units', () => {
		expect(formatMinorUnits(1299, 'GBP', 'en-GB')).toBe('£12.99');
		expect(formatMinorUnits(0, 'GBP', 'en-GB')).toBe('£0.00');
		expect(formatMinorUnits(1299, 'USD', 'en-US')).toBe('$12.99');
	});

	it('respects zero-decimal currencies', () => {
		expect(formatMinorUnits(1299, 'JPY', 'en-US')).toBe('¥1,299');
	});
});
