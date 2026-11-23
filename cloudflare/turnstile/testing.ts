import type { ITurnstileClient } from './client';

/** Passes or fails every check, and records what was asked. */
export class FakeTurnstileClient implements ITurnstileClient {
	readonly checks: Parameters<ITurnstileClient['verify']>[0][] = [];

	constructor(
		private human = true,
		private readonly key = 'fake-site-key'
	) {}

	respondWith(human: boolean): void {
		this.human = human;
	}

	siteKey(): string {
		return this.key;
	}

	verify(check: Parameters<ITurnstileClient['verify']>[0]): Promise<boolean> {
		this.checks.push(check);
		return Promise.resolve(Boolean(check.token) && this.human);
	}
}
