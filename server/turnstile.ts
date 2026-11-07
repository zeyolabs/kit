import { FormResult } from '../utils/form';

/**
 * Server-side verification of a Cloudflare Turnstile token against the siteverify API. Pure
 * `fetch`, no framework or binding dependency. Each app owns how it obtains the secret key and how
 * a rejection surfaces (see `apps/web/src/lib/server/turnstile.ts`).
 */
export async function verifyTurnstile(
	token: string,
	ip: null | string | undefined,
	secretKey: string
): Promise<boolean> {
	const params = new URLSearchParams({ response: token, secret: secretKey });
	if (ip) params.set('remoteip', ip);
	const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
		body: params,
		method: 'POST',
	});
	const result = (await response.json()) as { success?: boolean };
	return result.success === true;
}

/**
 * Where a Turnstile gate gets the request's client address and the secret key. The app supplies it
 * (SvelteKit's `getRequestEvent()`, a Secrets Store binding, a loopback test key), so the gate
 * itself has no framework or binding dependency.
 */
export type TurnstileContext = () =>
	| Promise<{ ip: null | string | undefined; secret: string }>
	| { ip: null | string | undefined; secret: string };

/**
 * Gates a form handler behind Turnstile. The validated input carries `turnstileToken`; the gate
 * verifies it and strips it before calling the handler. A missing or rejected token returns
 * `FormResult.err(message)` and the handler never runs.
 */
export function turnstileGate(
	context: TurnstileContext,
	{ message = 'Bot check failed. Please try again.' }: { message?: string } = {}
) {
	return function gate<TData extends { turnstileToken: string }, TResult>(
		handler: (data: Omit<TData, 'turnstileToken'>) => Promise<FormResult<TResult | void>>
	): (data: TData) => Promise<FormResult<TResult | void>> {
		return async ({ turnstileToken, ...data }: TData) => {
			if (!turnstileToken) return FormResult.err(message);
			const { ip, secret } = await context();
			if (!(await verifyTurnstile(turnstileToken, ip, secret))) return FormResult.err(message);
			return handler(data as Omit<TData, 'turnstileToken'>);
		};
	};
}
