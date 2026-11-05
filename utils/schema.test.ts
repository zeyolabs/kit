import { describe, expect, it } from 'vitest';

import { Schema } from './schema';

describe('Schema.Email', () => {
	it('trims and lowercases', () => {
		expect(Schema.Email.parse('  Mark@Example.COM  ')).toBe('mark@example.com');
	});

	it('rejects an invalid format even after trimming', () => {
		expect(Schema.Email.safeParse('  not-an-email  ').success).toBe(false);
	});
});
