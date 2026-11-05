import { describe, expect, it, vi } from 'vitest';

import { PrometheusClient } from './client';

const CREDS = { password: 'pw', user: 'user' };

describe('PrometheusClient.push', () => {
	it('no-ops on zero samples, never touching the binding', async () => {
		const fetchImpl = vi.fn();
		const client = new PrometheusClient({ ...CREDS, vpc: { fetch: fetchImpl } as never });
		await expect(client.push()).resolves.toBeUndefined();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('pushes successfully when the binding is present', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
		const client = new PrometheusClient({ ...CREDS, vpc: { fetch: fetchImpl } as never });
		await expect(client.push({ name: 'test_metric', value: 1 })).resolves.toBeUndefined();
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('throws when Prometheus returns a non-2xx', async () => {
		const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
		const client = new PrometheusClient({ ...CREDS, vpc: { fetch: fetchImpl } as never });
		await expect(client.push({ name: 'test_metric', value: 1 })).rejects.toThrow('500');
	});
});
