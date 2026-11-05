const HTML_ESCAPES: Record<string, string> = {
	"'": '&#39;',
	'"': '&quot;',
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
};

/** Turns a raw value into a display string — a plain object of functions (a Library, same pattern
 *  as `Crypto`/`Schema`/`Normalize`), not a service: pure output formatting, no I/O. Distinct from
 *  `Normalize` (canonicalizing a value down to its minimal storage form) — this goes the other
 *  way, storage/domain value → presentation string. */
export const Format = {
	/** Escape a string for safe interpolation into HTML text/attribute content. */
	escapeHtml(value: string): string {
		return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);
	},

	/** USD currency, always 2 decimal places, e.g. 1234.5 → "$1,234.50". */
	money(amount: number): string {
		return amount.toLocaleString(undefined, {
			currency: 'USD',
			maximumFractionDigits: 2,
			minimumFractionDigits: 2,
			style: 'currency',
		});
	},

	/** One CSV cell, always double-quoted (embedded `"` doubled) — `null`/`undefined` → `''`. */
	csvField(value: null | number | string | undefined): string {
		return value == null ? '' : `"${String(value).replace(/"/g, '""')}"`;
	},

	/** Abbreviated count with a trailing "+", e.g. 1_234_567 → "1.2M+", 3_400 → "3K+". Falsy/missing → "N/A". */
	compactCount(n: null | number | undefined): string {
		if (!n) return 'N/A';
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M+`;
		if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K+`;
		return `${n}`;
	},

	/** Abbreviated USD amount with a T/B/M suffix, e.g. 1_500_000 → "$1.5M". `<= 0`/missing → "N/A". */
	compactMoney(amount: null | number | undefined): string {
		if (!amount || amount <= 0) return 'N/A';
		if (amount >= 1_000_000_000_000) return `$${(amount / 1_000_000_000_000).toFixed(2)}T`;
		if (amount >= 1_000_000_000)
			return `$${(amount / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
		if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
		return `$${amount.toLocaleString('en-US')}`;
	},
};
