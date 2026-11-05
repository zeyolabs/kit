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
