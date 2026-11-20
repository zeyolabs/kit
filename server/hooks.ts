import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

import { isMalformedFormRequest, logRemoteValidation } from './remote-functions';

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
