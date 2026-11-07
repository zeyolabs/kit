import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormResult } from '../utils/form';
import { TurnstileClient, turnstileGate } from './turnstile';
import { FakeTurnstileClient } from './turnstile.testing';

afterEach(() => vi.unstubAllGlobals());

function siteverify(success: boolean) {
	const fetchMock = vi.fn(async () => Response.json({ success }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

describe('TurnstileClient', () => {
	it('sends token, secret and ip to siteverify', async () => {
		const fetchMock = siteverify(true);
		expect(await new TurnstileClient('secret').verify('tok', '1.2.3.4')).toBe(true);
		const body = (fetchMock.mock.calls[0] as unknown as [string, { body: URLSearchParams }])[1]
			.body;
		expect(body.get('response')).toBe('tok');
		expect(body.get('secret')).toBe('secret');
		expect(body.get('remoteip')).toBe('1.2.3.4');
	});

	it('resolves a secret function on each call', async () => {
		siteverify(true);
		const secret = vi.fn(async () => 's');
		const client = new TurnstileClient(secret);
		await client.verify('a');
		await client.verify('b');
		expect(secret).toHaveBeenCalledTimes(2);
	});

	it('is false for a rejected token and never calls siteverify for an empty one', async () => {
		const fetchMock = siteverify(false);
		expect(await new TurnstileClient('s').verify('bad')).toBe(false);
		fetchMock.mockClear();
		expect(await new TurnstileClient('s').verify('')).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('turnstileGate', () => {
	it('verifies, strips the token and calls the handler', async () => {
		const client = new FakeTurnstileClient();
		const handler = vi.fn(async (data: { name: string }) => FormResult.err(data.name));
		const result = await turnstileGate(client, () => '1.2.3.4')(handler)({
			name: 'Ada',
			turnstileToken: 'valid',
		});
		expect(handler).toHaveBeenCalledWith({ name: 'Ada' });
		expect(result.message).toBe('Ada');
		expect(client.calls).toEqual([{ ip: '1.2.3.4', token: 'valid' }]);
	});

	it('returns the error and skips the handler when verification fails', async () => {
		const handler = vi.fn();
		const result = await turnstileGate(new FakeTurnstileClient())(handler)({
			turnstileToken: 'bad',
		});
		expect(result).toEqual(FormResult.err('Bot check failed. Please try again.'));
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a missing token and uses a custom message', async () => {
		const handler = vi.fn();
		const result = await turnstileGate(new FakeTurnstileClient(), undefined, { message: 'Nope' })(
			handler
		)({ turnstileToken: '' });
		expect(result.message).toBe('Nope');
		expect(handler).not.toHaveBeenCalled();
	});
});
