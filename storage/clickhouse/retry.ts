import { ClickHouseError } from '@clickhouse/client-web';

/** A `ClickHouseError` is a deterministic server rejection (bad SQL, memory limit, unknown table) — not
 *  worth retrying. Anything else is a transient transport blip, retryable for an idempotent read. Our own
 *  deadline is caught via `signal.aborted` in `withTransportRetry`, never by matching `err.name`. */
export function isRetryableTransportError(err: unknown): boolean {
	return !(err instanceof ClickHouseError);
}

/** Retry an idempotent CH transport call over a transient connection drop — exp backoff + jitter. Owns a
 *  per-attempt deadline (`AbortSignal.timeout`) and passes it to `run`, which MUST forward it to the CH
 *  call's `abort_signal`. A fired deadline is detected via `signal.aborted`, so our own timeout stops the
 *  loop while a fast transport failure is still retried. */
export async function withTransportRetry<T>(
	run: (signal: AbortSignal) => Promise<T>,
	{ attempts = 3, timeoutMs = 60_000 }: { attempts?: number; timeoutMs?: number } = {}
): Promise<T> {
	for (let i = 0; ; i++) {
		const signal = AbortSignal.timeout(timeoutMs);
		try {
			return await run(signal);
		} catch (err) {
			// Our own deadline elapsed → stop; retrying would only stack latency past the ceiling.
			if (signal.aborted) throw err;
			if (i >= attempts - 1 || !isRetryableTransportError(err)) throw err;
			const backoff = 2 ** i * 50 + Math.random() * 50; // 50ms/100ms + jitter
			await new Promise((resolve) => setTimeout(resolve, backoff));
		}
	}
}
