import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GatesClient } from './client';

function serviceWith(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>
): GatesClient {
	return new GatesClient({ fetch: fetchImpl } as unknown as Fetcher);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

describe('GatesClient.get', () => {
	it('returns the parsed gate on a 200', async () => {
		const gate = { key: 'process_jobs', namespace: 'sender', value: true };
		const gates = serviceWith(async () => jsonResponse(gate));
		await expect(gates.get('sender', 'process_jobs')).resolves.toEqual(gate);
	});

	it('returns null on a 404', async () => {
		const gates = serviceWith(async () => new Response('not found', { status: 404 }));
		await expect(gates.get('sender', 'process_jobs')).resolves.toBeNull();
	});

	it('throws on any other non-2xx status', async () => {
		const gates = serviceWith(async () => new Response('boom', { status: 500 }));
		await expect(gates.get('sender', 'process_jobs')).rejects.toThrow('500');
	});

	it('encodes namespace/key into the path', async () => {
		let capturedUrl = '';
		const gates = serviceWith(async (url) => {
			capturedUrl = url;
			return jsonResponse({ key: 'c/d', namespace: 'a b', value: false });
		});
		await gates.get('a b', 'c/d');
		expect(capturedUrl).toBe('http://gates/v1/namespaces/a%20b/gates/c%2Fd');
	});
});

describe('GatesClient.list', () => {
	it('returns the parsed list', async () => {
		const list = [{ key: 'process_jobs', namespace: 'sender', value: false }];
		const gates = serviceWith(async () => jsonResponse(list));
		await expect(gates.list('sender')).resolves.toEqual(list);
	});
});

describe('GatesClient.set', () => {
	it('PUTs the value and returns the parsed gate', async () => {
		let capturedInit: RequestInit | undefined;
		const gate = { key: 'process_jobs', namespace: 'sender', value: true };
		const gates = serviceWith(async (_url, init) => {
			capturedInit = init;
			return jsonResponse(gate);
		});
		await expect(gates.set('sender', 'process_jobs', true)).resolves.toEqual(gate);
		expect(capturedInit?.method).toBe('PUT');
		expect(capturedInit?.body).toBe(JSON.stringify({ value: true }));
	});
});

describe('GatesClient.delete', () => {
	it('resolves on a 204', async () => {
		const gates = serviceWith(async () => new Response(null, { status: 204 }));
		await expect(gates.delete('sender', 'process_jobs')).resolves.toBeUndefined();
	});

	it('resolves on a 404 (already gone)', async () => {
		const gates = serviceWith(async () => new Response(null, { status: 404 }));
		await expect(gates.delete('sender', 'process_jobs')).resolves.toBeUndefined();
	});

	it('throws on any other non-2xx status', async () => {
		const gates = serviceWith(async () => new Response(null, { status: 500 }));
		await expect(gates.delete('sender', 'process_jobs')).rejects.toThrow('500');
	});
});

describe('GatesClient.getFlag', () => {
	// distinct key per test — the cache is module-level, shared across tests otherwise
	let n = 0;
	let key: string;
	beforeEach(() => {
		vi.useFakeTimers();
		key = `k${n++}`;
	});
	afterEach(() => vi.useRealTimers());

	it('returns the live value and caches it', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ key, namespace: 'ns', value: true }));
		const gates = serviceWith(fetchImpl);
		await expect(gates.getFlag(`ns/${key}`, false)).resolves.toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('serves a fresh (<5s) read from cache without a second fetch', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ key, namespace: 'ns', value: true }));
		const gates = serviceWith(fetchImpl);
		await gates.getFlag(`ns/${key}`, false);
		vi.advanceTimersByTime(4_000);
		await expect(gates.getFlag(`ns/${key}`, false)).resolves.toBe(true);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('fetches again once the 5s fresh window has passed', async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ key, namespace: 'ns', value: true }));
		const gates = serviceWith(fetchImpl);
		await gates.getFlag(`ns/${key}`, false);
		vi.advanceTimersByTime(5_001);
		await gates.getFlag(`ns/${key}`, false);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it('falls back to the last known value when a later fetch fails within 60s', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ key, namespace: 'ns', value: true }))
			.mockRejectedValueOnce(new Error('network down'));
		const gates = serviceWith(
			fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response>
		);
		await gates.getFlag(`ns/${key}`, false);
		vi.advanceTimersByTime(30_000); // past the 5s fresh window, within the 60s stale window
		await expect(gates.getFlag(`ns/${key}`, false)).resolves.toBe(true);
	});

	it('falls back to `fallback` once the last known value is older than 60s', async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ key, namespace: 'ns', value: true }))
			.mockRejectedValueOnce(new Error('network down'));
		const gates = serviceWith(
			fetchImpl as unknown as (url: string, init?: RequestInit) => Promise<Response>
		);
		await gates.getFlag(`ns/${key}`, false);
		vi.advanceTimersByTime(60_001);
		await expect(gates.getFlag(`ns/${key}`, false)).resolves.toBe(false);
	});

	it('falls back to `fallback` on failure with no prior successful read at all', async () => {
		const gates = serviceWith(async () => {
			throw new Error('network down');
		});
		await expect(gates.getFlag(`ns/${key}`, true)).resolves.toBe(true);
	});

	it('falls back to `fallback` when the gate is confirmed not set (no error)', async () => {
		const gates = serviceWith(async () => new Response('not found', { status: 404 }));
		await expect(gates.getFlag(`ns/${key}`, true)).resolves.toBe(true);
	});
});
