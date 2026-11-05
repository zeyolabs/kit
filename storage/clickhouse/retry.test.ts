import { ClickHouseError } from '@clickhouse/client-web';
import { describe, expect, it, vi } from 'vitest';

import { isRetryableTransportError, withTransportRetry } from './retry';

describe('isRetryableTransportError', () => {
	it('retries a raw transport Error (dropped connection)', () => {
		expect(isRetryableTransportError(new Error('connection lost'))).toBe(true);
	});

	it('retries a fetch TypeError', () => {
		expect(isRetryableTransportError(new TypeError('error sending request'))).toBe(true);
	});

	it('does NOT retry a ClickHouseError — the server rejected the query deterministically', () => {
		const serverErr = new ClickHouseError({
			code: '241',
			message: 'Memory limit exceeded',
			type: 'MEMORY_LIMIT_EXCEEDED',
		});
		expect(isRetryableTransportError(serverErr)).toBe(false);
	});

	it('treats a raw Abort/Timeout error as retryable — our OWN deadline is caught via the signal, not the name', () => {
		// A stale-socket handshake failure can surface as a `TimeoutError`; classifying by name would wrongly
		// exclude it from retry. Only our own deadline (checked via `signal.aborted` in withTransportRetry)
		// stops the loop.
		const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
		const timeout = Object.assign(new Error('handshake timeout'), { name: 'TimeoutError' });
		expect(isRetryableTransportError(abort)).toBe(true);
		expect(isRetryableTransportError(timeout)).toBe(true);
	});
});

describe('withTransportRetry', () => {
	it('retries a transient transport failure, then returns the eventual success', async () => {
		const run = vi
			.fn()
			.mockRejectedValueOnce(new Error('Network connection lost.'))
			.mockResolvedValueOnce('ok');
		await expect(withTransportRetry(run)).resolves.toBe('ok');
		expect(run).toHaveBeenCalledTimes(2);
	});

	it('throws a ClickHouseError immediately without retrying', async () => {
		const serverErr = new ClickHouseError({
			code: '60',
			message: 'Unknown table',
			type: 'UNKNOWN_TABLE',
		});
		const run = vi.fn().mockRejectedValue(serverErr);
		await expect(withTransportRetry(run)).rejects.toBe(serverErr);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it('gives up after `attempts` on a persistent transport failure', async () => {
		const run = vi.fn().mockRejectedValue(new Error('Network connection lost.'));
		await expect(withTransportRetry(run, { attempts: 3 })).rejects.toThrow(
			'Network connection lost.'
		);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it('stops without retrying once our own deadline fires', async () => {
		// `run` only settles when the deadline aborts — proving the loop stops on OUR timeout (signal.aborted),
		// not on any error name, and does not spin into another attempt.
		const run = vi.fn(
			(signal: AbortSignal) =>
				new Promise((_, reject) => {
					signal.addEventListener('abort', () => reject(signal.reason));
				})
		);
		await expect(withTransportRetry(run, { attempts: 3, timeoutMs: 10 })).rejects.toBeDefined();
		expect(run).toHaveBeenCalledTimes(1);
	});
});
