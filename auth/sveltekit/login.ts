// The login page's side of the auth routes: where to go after signing in, and error copy.

/** Login-page error codes; the app's login page maps them to copy with `loginErrorMessage`. */
export type LoginError = 'expired' | 'mismatch' | 'not_allowed' | 'passkey' | 'send';

const LOGIN_ERRORS: Record<LoginError, string> = {
	expired: 'That sign-in link has expired or was already used. Request a new one.',
	mismatch: 'Sign in with the same email you used for Cloudflare Access.',
	not_allowed: 'That email is not allowed to sign in here.',
	passkey: 'That passkey could not be verified. Try again or use an email link.',
	send: 'We could not send the email. Check the address and try again.',
};

/** A same-site path to go to after sign-in: never another origin (`//x`, `/\x`, `https:`). */
function safeNext(next: unknown): string {
	if (typeof next !== 'string' || !next.startsWith('/') || /^\/[/\\]/.test(next)) return '/';
	return next;
}

/** Copy for a login page's `?error=` code; `null` for none or an unknown one. */
function loginErrorMessage(code: null | string): null | string {
	return code && code in LOGIN_ERRORS ? LOGIN_ERRORS[code as LoginError] : null;
}

export const Login = {
	errorMessage: loginErrorMessage,
	safeNext,
};
