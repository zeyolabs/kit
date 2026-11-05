import { isHttpError } from '@sveltejs/kit';

import { FormResult } from '../utils/form';

/**
 * Gate a form handler behind a rate-limit guard. A guard throws SvelteKit's raw `error(429/503, ...)`,
 * which is meant for a `+page.server.ts` load: inside a `Remote.Form` handler it would hit the
 * catch-all, get logged as unexpected (Sentry noise on every throttled request) and show a generic
 * message instead of the real "try again in Ns" one. Convert it to an inline `FormResult.err` here.
 */
export function withRateLimit<TData, TResult>(
	guard: () => Promise<void>,
	handler: (data: TData) => Promise<FormResult<TResult | void>>
): (data: TData) => Promise<FormResult<TResult | void>> {
	return async (data: TData): Promise<FormResult<TResult | void>> => {
		try {
			await guard();
		} catch (e) {
			if (isHttpError(e)) return FormResult.err(e.body.message);
			throw e;
		}
		return handler(data);
	};
}
