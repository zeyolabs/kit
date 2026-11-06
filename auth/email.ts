import type { EmailBrand } from '../utils/email';
import type { MagicLinkMessage } from './config';

import { renderEmail, renderEmailText } from '../utils/email';

/** The sign-in email: subject, HTML and plain text. */
export function magicLinkEmail(brand: EmailBrand, message: MagicLinkMessage) {
	const params = {
		brand,
		cta: { href: message.url, label: `Sign in to ${brand.name}` },
		eyebrow: 'Sign in',
		footnote: `If you didn't ask to sign in, ignore this email: nobody can use the link without access to your inbox.`,
		heading: `Sign in to ${brand.name}`,
		intro: [
			`Use the button below to sign in as ${message.email}.`,
			`The link works once and expires in ${message.expiresInMinutes} minutes.`,
		],
		preheader: `Your sign-in link for ${brand.name}`,
		sections: [],
	};
	return {
		html: renderEmail(params),
		subject: `Sign in to ${brand.name}`,
		text: renderEmailText(params),
	};
}

/** An invitation to join an account. */
export function inviteEmail(
	brand: EmailBrand,
	invite: { accountName: string; inviter: string; url: string }
) {
	const params = {
		brand,
		cta: { href: invite.url, label: `Join ${invite.accountName}` },
		eyebrow: 'Invitation',
		footnote:
			'The invitation works once and expires in 7 days. Ignore this email if you were not expecting it.',
		heading: `Join ${invite.accountName} on ${brand.name}`,
		intro: [
			`${invite.inviter} invited you to ${invite.accountName}.`,
			'Sign in with this email address to accept.',
		],
		preheader: `${invite.inviter} invited you to ${invite.accountName}`,
		sections: [],
	};
	return {
		html: renderEmail(params),
		subject: `Join ${invite.accountName} on ${brand.name}`,
		text: renderEmailText(params),
	};
}
