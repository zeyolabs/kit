import { describe, expect, it } from 'vitest';

import { Normalize } from './normalize';

describe('Normalize.xHandle', () => {
	it('strips protocol + host from a full x.com URL', () => {
		expect(Normalize.xHandle('https://x.com/elonmusk')).toBe('elonmusk');
	});

	it('strips protocol + host from the legacy twitter.com host', () => {
		expect(Normalize.xHandle('https://twitter.com/elonmusk')).toBe('elonmusk');
	});

	it('accepts a host-only string with no protocol', () => {
		expect(Normalize.xHandle('x.com/elonmusk')).toBe('elonmusk');
	});

	it('strips a leading @ from a bare handle', () => {
		expect(Normalize.xHandle('@elonmusk')).toBe('elonmusk');
	});

	it('leaves an already-bare handle as-is', () => {
		expect(Normalize.xHandle('elonmusk')).toBe('elonmusk');
	});

	it('trims surrounding whitespace and slashes', () => {
		expect(Normalize.xHandle('  /elonmusk/  ')).toBe('elonmusk');
	});

	it('returns empty string for nothing usable', () => {
		expect(Normalize.xHandle('')).toBe('');
		expect(Normalize.xHandle('   ')).toBe('');
	});
});
