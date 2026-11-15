import { error } from '@sveltejs/kit';

import type { RateLimitClient } from './rate-limit-client';

/** The slice of a SvelteKit request event the guard reads. */
export type RateLimitEvent = {
	getClientAddress(): string;
	request: Request;
};

export type RateLimitGuardOptions = {
	/** The client, resolved per call (built from the request's env at the edge). */
	client: () => RateLimitClient;
	/** The current request, normally `getRequestEvent`. */
	event: () => RateLimitEvent;
	/** True to skip the check entirely (dev, prerender). */
	skip?: () => boolean;
};

export type RateLimitGuardCheck = { failClosed?: boolean };

/**
 * Rate limiting for a request: a library (static functions, no state). `RateLimit.guard` returns
 * a function that identifies the caller by IP, skips Cloudflare-verified crawlers (`cf.verifiedBot`
 * is set after IP-range verification, so a user agent can't spoof it), and throws SvelteKit's
 * `error(429)` over the limit. Pair it with `withRateLimit` inside a form handler.
 *
 * `failClosed` turns an unreachable limiter into a 503 instead of letting the request through:
 * use it for abuse-sensitive endpoints where an outage must not lift the cap.
 */
export const RateLimit = {
	guard({ client, event, skip = () => false }: RateLimitGuardOptions) {
		return async function guard(
			category = 'public:default',
			{ failClosed = false }: RateLimitGuardCheck = {}
		): Promise<void> {
			if (skip()) return;

			const current = event();
			if ((current.request as Request & { cf?: { verifiedBot?: boolean } }).cf?.verifiedBot) return;

			// getClientAddress() throws when the address is unknown (wrangler dev, LAN peers).
			let ip = 'unknown';
			try {
				ip = current.getClientAddress();
			} catch {
				// keep 'unknown'; production on Cloudflare always resolves an address
			}

			const result = await client().check(`ip:${ip}`, category);

			if (result.unavailable) {
				if (failClosed) throw error(503, 'Rate limiter unavailable. Please try again later.');
				return;
			}
			if (!result.allowed) {
				throw error(429, `Rate limit exceeded. Try again in ${result.retryAfter}s`);
			}
		};
	},
};
