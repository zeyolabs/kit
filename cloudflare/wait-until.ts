/** `cloudflare:workers`'s `waitUntil` only exists in the real Workers runtime — a plain Node
 *  process (local SvelteKit dev, route analysis during `vite build`, most test runs) has no such
 *  module, so it's imported dynamically here and swallowed if that fails: there's nothing to do to
 *  extend a promise's lifetime outside the Workers runtime anyway. */
export async function waitUntil(promise: Promise<unknown>): Promise<void> {
	try {
		const workers = await import('cloudflare:workers');
		workers.waitUntil(promise);
	} catch {
		// Not in the Workers runtime — no way to keep this alive past the caller's response.
	}
}
