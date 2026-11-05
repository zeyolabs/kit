import type { LoggerClient } from './logger';

export type RateLimiterBinding = {
	get(id: unknown): {
		fetch(
			input: string,
			init?: { body?: string; method?: string; signal?: AbortSignal }
		): Promise<LimiterResponse>;
	};
	idFromName(name: string): unknown;
};
// Structural shape of the RATE_LIMITER durable object binding, so this file doesn't depend on
// @cloudflare/workers-types.
type LimiterResponse = { json<T>(): Promise<T>; ok: boolean; status: number };

export type RateLimitConfig = { requests: number; window: number };

export type RateLimitResult = {
	allowed: boolean;
	remaining?: number;
	resetAt?: number;
	retryAfter?: number;
	/**
	 * True when the limiter binding was missing or unreachable, so `allowed` is a fail-open default,
	 * not a real verdict. Callers that need fail-CLOSED behaviour (abuse-sensitive public endpoints)
	 * inspect this to reject with a 503 instead of silently passing.
	 */
	unavailable?: boolean;
};

/**
 * Shared rate-limit logic. The RATE_LIMITER durable-object binding is injected;
 * returns a result and the caller decides how to reject (e.g. a 429). Fails open: if the binding is
 * missing or unreachable the request passes, flagged `unavailable`.
 */
export class RateLimitClient {
	constructor(
		private readonly limiter: RateLimiterBinding | undefined,
		private readonly logger: LoggerClient,
		private readonly configFor: (category: string) => RateLimitConfig
	) {}

	async check(identifier: string, category: string): Promise<RateLimitResult> {
		if (!this.limiter) return { allowed: true, unavailable: true };

		const config = this.configFor(category);
		const stub = this.limiter.get(this.limiter.idFromName(identifier));

		try {
			// Timeout so a hung DO doesn't block the whole request; 5s clears ordinary
			// Worker-to-DO subrequest latency.
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);

			const response = await stub.fetch('https://fake-host', {
				body: JSON.stringify({
					category,
					limit: config.requests,
					userId: identifier,
					window: config.window,
				}),
				method: 'POST',
				signal: controller.signal,
			});

			clearTimeout(timeout);

			// 429 is the DO's real verdict (over the limit), with retryAfter in the body.
			if (response.status === 429) return await response.json<RateLimitResult>();
			// Anything else non-2xx: DO unavailable, so allow.
			if (!response.ok) return { allowed: true, unavailable: true };

			return await response.json<RateLimitResult>();
		} catch (err) {
			// DO timeout or failure: fail open.
			this.logger.error(err, { op: 'rateLimitCheck' });
			return { allowed: true, unavailable: true };
		}
	}
}

/** Stands in for the binding when absent (local dev): always allows and is not `unavailable`. */
export const localDevLimiter: RateLimiterBinding = {
	get: () => ({
		fetch: async () => ({ json: async <T>() => ({ allowed: true }) as T, ok: true, status: 200 }),
	}),
	idFromName: (name: string) => name,
};
