import type { ITurnstileClient } from '../cloudflare/turnstile/client';
import type { AuthDb } from './config';
import type { LoginError } from './login';

import { turnstile } from '../cloudflare/turnstile/client';
import { logger } from '../server/logger';
import { Schema } from '../utils/schema';
import { Auth } from './config';
import { AuthEmails } from './emails';
import { MagicLink } from './sessions/magic-link/magic-link';
import { Users } from './users';

/** What the "email me a sign-in link" form asks for. */
export type EmailLinkRequest = {
	/** The Access identity the visitor already has, if the app sits behind Access. */
	accessEmail: null | string;
	email: unknown;
	hostname: string;
	ip: null | string;
	next: string;
	/** The site's origin, for the link in the email. */
	origin: string;
	/** The Turnstile token the widget put in the form. */
	turnstileToken: string;
};

/** `error` is why nothing was sent; `sent` is whether the page should say "check your email". */
export type EmailLinkResult = { error: LoginError | null; sent: boolean };

/**
 * The email-link sign-in: the bot check (when the app has Turnstile on), the allowlist, then a
 * single-use link by email. Unknown emails get the same answer as known ones, so the form can't
 * probe the allowlist.
 */
export class EmailLinkService {
	constructor(
		private readonly db: AuthDb,
		private readonly turnstile: ITurnstileClient | null
	) {}

	/** Checks an email against the allowlist and the Access identity. */
	static async refusal(email: string, accessEmail: null | string): Promise<LoginError | null> {
		if (!(await Auth.config().isAllowed(email))) return 'not_allowed';
		if (accessEmail && !Users.emailsMatch(accessEmail, email)) return 'mismatch';
		return null;
	}

	async request(input: EmailLinkRequest): Promise<EmailLinkResult> {
		if (this.turnstile) {
			const human = await this.turnstile.verify({
				hostname: input.hostname,
				ip: input.ip,
				token: input.turnstileToken,
			});
			if (!human) return { error: 'bot', sent: false };
		}
		const parsed = Schema.Email.safeParse(input.email);
		if (!parsed.success) return { error: 'send', sent: false };
		const email = parsed.data;

		const refused = await EmailLinkService.refusal(email, input.accessEmail);
		if (refused === 'not_allowed') return { error: null, sent: true };
		if (refused) return { error: refused, sent: false };

		const token = await MagicLink.issue(this.db, email);
		if (token) {
			const url = new URL(Auth.config().loginPath, input.origin);
			url.searchParams.set('token', token);
			if (input.next !== '/') url.searchParams.set('next', input.next);
			try {
				const message = { email, expiresInMinutes: MagicLink.TTL_MS / 60_000, url: url.href };
				await Auth.config()
					.email()
					.deliver({ to: email, ...AuthEmails.magicLink(Auth.config().emailBrand, message) });
			} catch (err) {
				logger.error(err, { op: 'auth.magic-link.send' });
				return { error: 'send', sent: false };
			}
		}
		return { error: null, sent: true };
	}
}

/** Built fresh per request from the app's auth config. */
export function emailLinks(): EmailLinkService {
	const { db, turnstile: widget } = Auth.config();
	return new EmailLinkService(db(), widget ? turnstile(widget.secretName) : null);
}
