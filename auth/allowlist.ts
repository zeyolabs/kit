/** Parses a comma-separated allowlist (e.g. an `ALLOWED_EMAILS` var) into lower-cased emails. */
function parseAllowlist(raw: string | undefined): string[] {
	return (raw ?? '')
		.split(',')
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
}

/** Case-insensitive allowlist check. An empty list allows nobody (fail closed). */
function isEmailAllowed(email: string, allowlist: readonly string[] | string | undefined) {
	const list =
		typeof allowlist === 'string' || allowlist === undefined
			? parseAllowlist(allowlist)
			: allowlist.map((e) => e.trim().toLowerCase());
	return list.includes(email.trim().toLowerCase());
}

/** Whether two addresses are the same email, ignoring case and spaces. */
function emailsMatch(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export const Allowlist = {
	includes: isEmailAllowed,
	matches: emailsMatch,
	parse: parseAllowlist,
};
