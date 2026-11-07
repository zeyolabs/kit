import { FormResult } from '../utils/form';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Server-side verification of a Cloudflare Turnstile token against the siteverify API. Pure
 * `fetch`, no framework or binding dependency. Prefer `Turnstile.verify` / `Turnstile.gate`.
 */
export async function verifyTurnstile(
	token: string,
	ip: null | string | undefined,
	secretKey: string
): Promise<boolean> {
	const params = new URLSearchParams({ response: token, secret: secretKey });
	if (ip) params.set('remoteip', ip);
	const response = await fetch(SITEVERIFY_URL, { body: params, method: 'POST' });
	const result = (await response.json()) as { success?: boolean };
	return result.success === true;
}

/** Where a gate gets the request's secret key and client address. The app supplies both. */
export type TurnstileGateOptions = {
	/** Client address per call (SvelteKit's `getRequestEvent().getClientAddress()`); may be null. */
	ip?: () => null | string | undefined;
	/** The error shown when the check fails. */
	message?: string;
	/** The secret key: a string, or a function called per check (a Secrets Store binding, a loopback test key). */
	secret: (() => Promise<string> | string) | string;
};

/**
 * Turnstile helpers: a library (an object of static functions, no state, no bindings), like
 * `Schema` and `FormResult`.
 */
export const Turnstile = {
	/**
	 * Gates a form handler behind Turnstile. The validated input carries `turnstileToken`; the gate
	 * verifies it and strips it before calling the handler. A missing or rejected token returns
	 * `FormResult.err(message)` and the handler never runs; a throwing `secret` or `fetch` also
	 * stops the handler (fails closed).
	 */
	gate({
		ip = () => null,
		message = 'Bot check failed. Please try again.',
		secret,
	}: TurnstileGateOptions) {
		return function gated<TData extends { turnstileToken: string }, TResult>(
			handler: (data: Omit<TData, 'turnstileToken'>) => Promise<FormResult<TResult | void>>
		): (data: TData) => Promise<FormResult<TResult | void>> {
			return async ({ turnstileToken, ...data }: TData) => {
				if (!(await Turnstile.verify(turnstileToken, ip(), secret))) return FormResult.err(message);
				return handler(data as Omit<TData, 'turnstileToken'>);
			};
		};
	},

	/**
	 * True only when siteverify accepts the token. An empty token is false without a request, and
	 * `secret` is only resolved when there is a token to check.
	 */
	async verify(
		token: string,
		ip: null | string | undefined,
		secret: (() => Promise<string> | string) | string
	): Promise<boolean> {
		if (!token) return false;
		const key = typeof secret === 'function' ? await secret() : secret;
		return verifyTurnstile(token, ip, key);
	},
};
