import type { ITurnstileClient } from './client';

/** Passes or fails every check, and records what was asked. */
export class FakeTurnstileClient implements ITurnstileClient {
	readonly checks: Parameters<ITurnstileClient['verify']>[0][] = [];

	constructor(private human = true) {}

	respondWith(human: boolean): void {
		this.human = human;
	}

	siteKey(_hostname: string, siteKey: string): string {
		return siteKey;
	}

	verify(check: Parameters<ITurnstileClient['verify']>[0]): Promise<boolean> {
		this.checks.push(check);
		return Promise.resolve(Boolean(check.token) && this.human);
	}
}
