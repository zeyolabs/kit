import { describe, expect, it } from 'vitest';

import { Error404, ErrorFields, ServiceError, toHttpError } from './errors';

describe('toHttpError', () => {
	it('keeps the status, message and body of a ServiceError', () => {
		const result = toHttpError(ErrorFields({ email: 'taken' }, 'nope'));
		expect(result).toEqual({
			body: { email: 'taken' },
			expected: true,
			message: 'nope',
			status: 400,
		});
	});

	it('collapses unexpected errors to a generic 500 without leaking the message', () => {
		const result = toHttpError(new Error('connection string postgres://secret'));
		expect(result).toEqual({ expected: false, message: 'Internal server error', status: 500 });
	});

	it('builds typed ServiceErrors', () => {
		const error = Error404('missing');
		expect(error).toBeInstanceOf(ServiceError);
		expect(error.status).toBe(404);
	});
});
