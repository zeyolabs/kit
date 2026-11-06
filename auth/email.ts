import type { EmailBrand } from '../utils/email';
import type { MagicLinkMessage } from './config';

import { renderEmail, renderEmailText } from '../utils/email';

/** A ready-made sign-in email for `sendMagicLink`: subject, HTML and plain text. */
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
