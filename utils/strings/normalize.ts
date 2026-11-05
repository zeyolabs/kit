import { parse } from 'tldts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
	return EMAIL_RE.test(value);
}

/** Cleans a raw value down to its minimal storage form — a plain object of functions (a
 *  Library, same pattern as `Crypto`/`Schema`), not a service: pure string transforms, no I/O. */
export const Normalize = {
	email(value: string): string {
		return value.trim().toLowerCase();
	},

	/**
	 * The registrable (root) domain for a URL or bare hostname via the Public Suffix List, or `''`
	 * when none can be parsed. e.g. `https://www.skma.co.uk/x` → `skma.co.uk`.
	 */
	domain(raw: string): string {
		const value = raw.trim().toLowerCase();
		if (!value) return '';
		const url = /^[a-z][a-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`;
		return parse(url).domain ?? '';
	},

	/**
	 * A URL cleaned to its minimal storage form: no protocol (`https` is always assumed at
	 * display/export — see `fullUrl` in `lists/columns.ts`), `www` dropped, any other subdomain
	 * kept, no trailing slash-only path. `''` when nothing parseable.
	 * e.g. `https://www.domain.com/` → `domain.com`; `http://blog.domain.com` → `blog.domain.com`;
	 * `domain.com/pricing` → `domain.com/pricing`.
	 */
	url(raw: string): string {
		const value = raw.trim();
		if (!value) return '';
		const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
		let url: URL;
		try {
			url = new URL(withProtocol);
		} catch {
			return '';
		}
		const parsed = parse(url.hostname.toLowerCase());
		if (!parsed.domain) return '';
		const subdomain = parsed.subdomain && parsed.subdomain !== 'www' ? `${parsed.subdomain}.` : '';
		const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
		return `${subdomain}${parsed.domain}${path}${url.search}${url.hash}`;
	},

	/**
	 * An X/Twitter profile reduced to its bare handle: no `@`, no host, no protocol — storage is
	 * always the minimal form, `xFullUrl` (`lists/columns.ts`) rebuilds the clickable profile URL at
	 * display/export time. Accepts a full URL (`x.com` or the legacy `twitter.com` host), a bare
	 * `@handle`, or an already-bare handle. `''` when nothing usable is left.
	 * e.g. `https://x.com/elonmusk` → `elonmusk`; `twitter.com/elonmusk` → `elonmusk`;
	 * `@elonmusk` → `elonmusk`.
	 */
	xHandle(raw: string): string {
		const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
		if (!trimmed) return '';
		if (!/(?:^|[./])(x|twitter)\.com/i.test(trimmed)) return trimmed.replace(/^@/, ''); // already bare
		const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		try {
			return new URL(withProtocol).pathname.replace(/^\/+|\/+$/g, '');
		} catch {
			return trimmed.replace(/^@/, '');
		}
	},
};

/** Deterministic slug: lowercase, non-alphanumeric runs collapsed to a single `-`, no leading or
 *  trailing dash. e.g. "Q3 Growth — Final!" → "q3-growth-final". */
export function slugify(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Title-cases each word ("SHELDON" / "mark" → "Sheldon" / "Mark") — for a person's name, not
 *  free text (would mangle brand names/acronyms). */
export function titleCase(str: string): string {
	return str.replace(
		/\w\S*/g,
		(txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
	);
}

/** e.g. "John Doe" → "JD". Falls back to "?" for a blank/whitespace-only name. */
export function initials(name: string, max = 2): string {
	return (
		name
			.split(' ')
			.filter(Boolean)
			.slice(0, max)
			.map((w) => w[0]?.toUpperCase())
			.join('') || '?'
	);
}

/** Subsequence match — every character of `needle` appears in `haystack`, in order. */
export function fuzzySearch(needle: string, haystack: string): boolean {
	const hlen = haystack.length;
	const nlen = needle.length;

	if (nlen > hlen) {
		return false;
	}
	if (nlen === hlen) {
		return needle.toLowerCase() === haystack.toLowerCase();
	}

	const lowerNeedle = needle.toLowerCase();
	const lowerHaystack = haystack.toLowerCase();

	outer: for (let i = 0, j = 0; i < nlen; i++) {
		const nch = lowerNeedle.charCodeAt(i);
		while (j < hlen) {
			if (lowerHaystack.charCodeAt(j++) === nch) {
				continue outer;
			}
		}
		return false;
	}

	return true;
}
