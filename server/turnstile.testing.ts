import type { ITurnstileClient } from './turnstile';

/**
 * An in-memory Turnstile client: accepts only the tokens you list (default: `valid`) and records
 * every call, so a test can assert the gate verified without stubbing `fetch`.
 */
export class FakeTurnstileClient implements ITurnstileClient {
	readonly calls: { ip: null | string | undefined; token: string }[] = [];

	constructor(private readonly accepted: ReadonlySet<string> = new Set(['valid'])) {}

	async verify(token: string, ip?: null | string): Promise<boolean> {
		this.calls.push({ ip, token });
		return !!token && this.accepted.has(token);
	}
}
