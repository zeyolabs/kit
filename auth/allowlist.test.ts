import { describe, expect, it } from 'vitest';

import { Allowlist } from './allowlist';

describe('Allowlist', () => {
	it('checks case-insensitively and fails closed when empty', () => {
		expect(Allowlist.includes('ADA@example.com', 'bob@x.com, ada@example.com')).toBe(true);
		expect(Allowlist.includes('eve@example.com', 'ada@example.com')).toBe(false);
		expect(Allowlist.includes('ada@example.com', '')).toBe(false);
		expect(Allowlist.includes('ada@example.com', undefined)).toBe(false);
	});
});
