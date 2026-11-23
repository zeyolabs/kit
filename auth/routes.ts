import type { RequestEvent, RequestHandler } from '@sveltejs/kit';

import { SignInManager } from './sign-in-manager';

// The auth endpoints, mounted by the app with one file:
//   src/routes/auth/[...path]/+server.ts:  export { POST } from '@zeyolabs/kit/auth/routes';
//
//   POST /auth/email                  form {email, next}  -> emails a link, 303 login?sent=1
//   POST /auth/verify                 form {token, next}  -> uses the link, signs in, 303 next
//   POST /auth/logout                 form                -> 303 login
//   POST /auth/passkey/login-options  json                -> request options
//   POST /auth/passkey/login          json {credential, next} -> signs in, {redirect}
//   POST /auth/passkey/register-options json              -> creation options (fresh session)
//   POST /auth/passkey/register       json {credential, name} -> {ok}
//   POST /auth/passkey/delete         form {id, next}     -> 303 next
//   POST /auth/invite/accept          form {token}        -> joins the account, 303 its home
//
// The emailed link opens the login page (`?token=`), which posts it here from a button: mail
// scanners that prefetch links can't burn the token or sign anyone in.

const handlers: Record<string, (manager: SignInManager) => Promise<Response> | Response> = {
	email: (m) => m.emailLink(),
	'invite/accept': (m) => m.acceptInvite(),
	logout: (m) => m.logout(),
	'passkey/delete': (m) => m.passkeyDelete(),
	'passkey/login': (m) => m.passkeyLogin(),
	'passkey/login-options': (m) => m.passkeyLoginOptions(),
	'passkey/register': (m) => m.passkeyRegister(),
	'passkey/register-options': (m) => m.passkeyRegisterOptions(),
	verify: (m) => m.verifyLink(),
};

export const POST: RequestHandler = async (event: RequestEvent) => {
	// SvelteKit's CSRF check only covers form posts; the JSON endpoints need the same guard.
	if (event.request.headers.get('origin') !== event.url.origin) {
		return new Response('Cross-site request refused', { status: 403 });
	}
	const handler = handlers[event.params.path ?? ''];
	if (!handler) return new Response('Not found', { status: 404 });
	return handler(new SignInManager(event));
};
