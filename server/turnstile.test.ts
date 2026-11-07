import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormResult } from '../utils/form';
import { turnstileGate } from './turnstile';

afterEach(() => vi.unstubAllGlobals());

function siteverify(success: boolean) {
	const fetchMock = vi.fn(async () => Response.json({ success }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

const gate = turnstileGate(() => ({ ip: '1.2.3.4', secret: 'secret' }));

describe('turnstileGate', () => {
	it('verifies the token, strips it and calls the handler', async () => {
		const fetchMock = siteverify(true);
		const handler = vi.fn(async (data: { name: string }) => FormResult.err(data.name));
		const result = await gate(handler)({ name: 'Ada', turnstileToken: 'tok' });
		expect(handler).toHaveBeenCalledWith({ name: 'Ada' });
		expect(result.message).toBe('Ada');
		const body = (fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1]
			.body;
		expect(body.get('response')).toBe('tok');
		expect(body.get('secret')).toBe('secret');
		expect(body.get('remoteip')).toBe('1.2.3.4');
	});

	it('returns the error and skips the handler when verification fails', async () => {
		siteverify(false);
		const handler = vi.fn();
		const result = await gate(handler)({ turnstileToken: 'bad' });
		expect(result).toEqual(FormResult.err('Bot check failed. Please try again.'));
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a missing token without calling siteverify', async () => {
		const fetchMock = siteverify(true);
		const handler = vi.fn();
		const result = await gate(handler)({ turnstileToken: '' });
		expect(result.type).toBe('error');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});

	it('uses a custom message and an async context', async () => {
		siteverify(false);
		const custom = turnstileGate(async () => ({ ip: null, secret: 's' }), { message: 'Nope' });
		expect((await custom(vi.fn())({ turnstileToken: 'x' })).message).toBe('Nope');
	});
});
