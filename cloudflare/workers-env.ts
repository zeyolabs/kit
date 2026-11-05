/** The Workers bindings (`cloudflare:workers`'s `env`), or `{}` where there are none. The module
 *  only resolves inside the Workers runtime — not in the Node process that analyses routes during
 *  `vite build`, and the adapter throws on access while prerendering — so it's imported
 *  dynamically and any failure means "no bindings". */
export async function workersEnv(): Promise<Record<string, unknown>> {
	try {
		const { env } = await import('cloudflare:workers');
		return { ...env };
	} catch {
		return {};
	}
}
