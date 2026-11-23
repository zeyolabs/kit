import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

import { waitUntil } from '../cloudflare/wait-until';
import { isMalformedFormRequest, logRemoteValidation } from './remote-functions';

/** A public page worth keeping in Cloudflare's cache: an exact path, or everything under a prefix. */
export type PageCacheRule = ({ exact: string } | { prefix: string }) & { seconds: number };

const CACHEABLE_TYPES = /^(text\/html|application\/xml|text\/xml)\b/;

function cacheTtl(rules: readonly PageCacheRule[], pathname: string): null | number {
	for (const rule of rules) {
		const hit = 'exact' in rule ? pathname === rule.exact : pathname.startsWith(rule.prefix);
		if (hit) return rule.seconds;
	}
	return null;
}

/**
 * The server hooks every app shares. `handleError` is
 * `AppHooks.serverErrors(Sentry.handleErrorWithSentry(AppHooks.logError))`, and `securityHeaders`
 * goes last in the `handle` sequence.
 */
export const AppHooks = {
	/** Logs to the console too, so Workers Logs have the error when Sentry's quota is spent. */
	logError: (({ error, event }) => {
		console.error(`${event.request.method} ${event.url.pathname}`, error);
	}) satisfies HandleServerError,

	/**
	 * Security headers for every response. A `private` app (behind a login: admin, internal tools)
	 * is also never cached or indexed; a public site sets that per route itself.
	 */
	securityHeaders({ private: isPrivate }: { private: boolean }): Handle {
		return async ({ event, resolve }) => {
			let response = await resolve(event);
			// A WebSocket upgrade's headers can't change.
			if (response.status === 101) return response;
			try {
				response.headers.set('X-Content-Type-Options', 'nosniff');
			} catch {
				// A response passed through from a service binding has immutable headers: copy it.
				response = new Response(response.body, response);
				response.headers.set('X-Content-Type-Options', 'nosniff');
			}
			response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
			response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
			if (isPrivate) {
				response.headers.set('Cache-Control', 'private, no-store');
				response.headers.set('Referrer-Policy', 'same-origin');
				response.headers.set('X-Robots-Tag', 'noindex, nofollow');
			} else {
				response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
			}
			return response;
		};
	},

	/**
	 * Keeps the public pages in `rules` in Cloudflare's cache for a few seconds or minutes, so a
	 * crawler hitting the same page again and again costs one render, not one per request. Only an
	 * anonymous GET is served from, or stored in, the cache: a request with any cookie (a signed-in
	 * visitor, a basket) and a response that sets one always go to the app, as does anything but a
	 * 200 page or XML. Put it before the handles that read the session, so a hit skips them. The
	 * cache is per URL, so the same nonce and data go to everyone for `seconds`.
	 */
	pageCache(rules: readonly PageCacheRule[]): Handle {
		return async ({ event, resolve }) => {
			const seconds = cacheTtl(rules, event.url.pathname);
			const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default;
			if (!cache || seconds === null || event.request.method !== 'GET') return resolve(event);
			if (event.request.headers.has('cookie')) return resolve(event);

			const key = new Request(`${event.url.origin}${event.url.pathname}${event.url.search}`);
			const hit = await cache.match(key);
			if (hit) {
				const response = new Response(hit.body, hit);
				response.headers.set('X-Page-Cache', 'HIT');
				return response;
			}

			const response = await resolve(event);
			const type = response.headers.get('content-type') ?? '';
			if (
				response.status !== 200 ||
				response.headers.has('set-cookie') ||
				!CACHEABLE_TYPES.test(type)
			) {
				return response;
			}
			const stored = new Response(response.clone().body, response);
			stored.headers.set('Cache-Control', `public, max-age=${seconds}`);
			void waitUntil(cache.put(key, stored));
			const fresh = new Response(response.body, response);
			fresh.headers.set('X-Page-Cache', 'MISS');
			return fresh;
		};
	},

	/**
	 * SvelteKit 3 sends every error to `handleError`. Remote-function validation failures are logged
	 * with the function's name, forged form posts answer 400, expected errors (`error(404)`, unknown
	 * routes) are dropped, and only real failures reach `report`.
	 */
	serverErrors(report: HandleServerError): HandleServerError {
		return (input) => {
			if (input.kind === 'validation') return logRemoteValidation(input.event, input.issues);
			if (isMalformedFormRequest(input.error)) return { message: 'Bad request', status: 400 };
			if (input.kind !== 'unknown' && input.error.status < 500) return;
			return report(input);
		};
	},
};
