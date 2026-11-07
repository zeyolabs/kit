import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormResult } from '../utils/form';
import { Turnstile } from './turnstile';

afterEach(() => vi.unstubAllGlobals());

function siteverify(success: boolean) {
	const fetchMock = vi.fn(async () => Response.json({ success }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('Turnstile.verify', () => {
	it('sends token, secret and ip to siteverify', async () => {
		const fetchMock = siteverify(true);
		expect(await Turnstile.verify('tok', '1.2.3.4', 'secret')).toBe(true);
		const body = (fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1]
			.body;
		expect(body.get('response')).toBe('tok');
		expect(body.get('secret')).toBe('secret');
		expect(body.get('remoteip')).toBe('1.2.3.4');
	});

	it('resolves a secret function on each call', async () => {
		siteverify(true);
		const secret = vi.fn(async () => 's');
		await Turnstile.verify('a', null, secret);
		await Turnstile.verify('b', null, secret);
		expect(secret).toHaveBeenCalledTimes(2);
	});

	it('is false for a rejected token', async () => {
		siteverify(false);
		expect(await Turnstile.verify('bad', null, 's')).toBe(false);
	});

	it('is false for an empty token without a request or resolving the secret', async () => {
		const fetchMock = siteverify(true);
		const secret = vi.fn(() => 's');
		expect(await Turnstile.verify('', null, secret)).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(secret).not.toHaveBeenCalled();
	});
});

describe('Turnstile.gate', () => {
	it('verifies, strips the token and calls the handler', async () => {
		const fetchMock = siteverify(true);
		const handler = vi.fn(async (data: { name: string }) => FormResult.err(data.name));
		const result = await Turnstile.gate({ ip: () => '1.2.3.4', secret: () => 'secret' })(handler)({
			name: 'Ada',
			turnstileToken: 'valid',
		});
		expect(handler).toHaveBeenCalledWith({ name: 'Ada' });
		expect(result.message).toBe('Ada');
		const body = (fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1]
			.body;
		expect(body.get('remoteip')).toBe('1.2.3.4');
	});

	it('returns the error and skips the handler when verification fails', async () => {
		siteverify(false);
		const handler = vi.fn();
		const result = await Turnstile.gate({ secret: 's' })(handler)({
			turnstileToken: 'bad',
		});
		expect(result).toEqual(FormResult.err('Bot check failed. Please try again.'));
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a missing token and uses a custom message', async () => {
		const handler = vi.fn();
		const result = await Turnstile.gate({ message: 'Nope', secret: () => 's' })(handler)({
			turnstileToken: '',
		});
		expect(result.message).toBe('Nope');
		expect(handler).not.toHaveBeenCalled();
	});

	it('fails closed when the secret lookup throws', async () => {
		siteverify(true);
		const handler = vi.fn();
		const gated = Turnstile.gate({
			secret: () => {
				throw new Error('no secret');
			},
		})(handler);
		await expect(gated({ turnstileToken: 'x' })).rejects.toThrow('no secret');
		expect(handler).not.toHaveBeenCalled();
	});
});
