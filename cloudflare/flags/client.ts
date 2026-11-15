// Feature flags over a Cloudflare Flagship binding. No ambient context, no app-specific
// knowledge: the binding is passed in; the caller decides where it comes from (e.g. `env.FLAGS`).

/** The slice of the Flagship binding we use (`env.FLAGS` in wrangler's `flagship` config). */
export interface FlagshipBinding {
	getBooleanValue(key: string, defaultValue: boolean): Promise<boolean>;
}

/** Just the shape callers depend on: a test can hand-write a fake object matching this, or use
 *  `FakeFlagsClient` from `./testing`. */
export interface IFlagsClient {
	/** Never throws. Returns `fallback` when the flag is missing or Flagship fails. A flag that
	 *  gates a risky action must keep the `false` default, so Flagship being down can never turn it
	 *  on. */
	getBoolean(key: string, fallback?: boolean): Promise<boolean>;
}

export class FlagsClient implements IFlagsClient {
	constructor(private readonly binding: FlagshipBinding) {}

	async getBoolean(key: string, fallback = false): Promise<boolean> {
		try {
			return await this.binding.getBooleanValue(key, fallback);
		} catch (e) {
			console.warn(`flags: ${key} unreadable, using fallback`, {
				error: e instanceof Error ? e.message : String(e),
				fallback,
			});
			return fallback;
		}
	}
}
