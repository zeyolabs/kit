import { describe, expect, it } from 'vitest';

import { AppResult, Fail, Ok } from './result';

describe('AppResult', () => {
	it('Ok carries data and message', () => {
		const result = Ok({ id: 1 }, 'saved');
		expect(result).toBeInstanceOf(AppResult);
		expect(result).toMatchObject({ data: { id: 1 }, message: 'saved', ok: true });
	});

	it('Fail is a soft failure with a message', () => {
		expect(Fail('out of stock')).toMatchObject({ message: 'out of stock', ok: false });
	});
});
