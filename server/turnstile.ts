import { FormResult } from '../utils/form';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Server-side verification of a Cloudflare Turnstile token against the siteverify API. Pure
 * `fetch`, no framework or binding dependency. Prefer `TurnstileClient`; this stays for callers
 * that already hold the secret.
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

/** The Turnstile client interface: what a gate (or a test fake) needs. */
export type ITurnstileClient = {
	/** True only when siteverify accepts the token. Never true for an empty token. */
	verify(token: string, ip?: null | string): Promise<boolean>;
};

/**
 * A client: talks to Cloudflare's siteverify. The secret is a string or a function (a Secrets Store
 * binding, a loopback test key), resolved on each call so the client can be built once per isolate.
 */
export class TurnstileClient implements ITurnstileClient {
	constructor(private readonly secret: (() => Promise<string> | string) | string) {}

	async verify(token: string, ip?: null | string): Promise<boolean> {
		if (!token) return false;
		const secret = typeof this.secret === 'function' ? await this.secret() : this.secret;
		return verifyTurnstile(token, ip, secret);
	}
}

/**
 * Gates a form handler behind Turnstile. The validated input carries `turnstileToken`; the gate
 * verifies it with `client` and strips it before calling the handler. A missing or rejected token
 * returns `FormResult.err(message)` and the handler never runs. `ip` supplies the client address
 * per call (SvelteKit's `getRequestEvent().getClientAddress()`); it may return null.
 */
export function turnstileGate(
	client: ITurnstileClient,
	ip: () => null | string | undefined = () => null,
	{ message = 'Bot check failed. Please try again.' }: { message?: string } = {}
) {
	return function gate<TData extends { turnstileToken: string }, TResult>(
		handler: (data: Omit<TData, 'turnstileToken'>) => Promise<FormResult<TResult | void>>
	): (data: TData) => Promise<FormResult<TResult | void>> {
		return async ({ turnstileToken, ...data }: TData) => {
			if (!(await client.verify(turnstileToken, ip()))) return FormResult.err(message);
			return handler(data as Omit<TData, 'turnstileToken'>);
		};
	};
}
