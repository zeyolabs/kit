import type { Ai } from '@cloudflare/workers-types';

import type { IWorkersAiClient } from './client';

export class FakeWorkersAiClient implements IWorkersAiClient {
	readonly calls: Parameters<Ai['run']>[] = [];
	private readonly responses: unknown[] = [];

	respondWith(response: unknown): void {
		this.responses.push(response);
	}

	run(...args: Parameters<Ai['run']>): ReturnType<Ai['run']> {
		this.calls.push(args);
		return Promise.resolve(this.responses.shift()) as ReturnType<Ai['run']>;
	}
}
