import type { Ai } from '@cloudflare/workers-types';

import { envStore, type EnvStore } from '../../utils/env';

export interface IWorkersAiClient {
	run(...args: Parameters<Ai['run']>): ReturnType<Ai['run']>;
}

/**
 * Thin wrapper over the Workers AI binding (`env.AI` — Cloudflare's own hosted models). No
 * business logic of its own — a feature builds its own prompt and parses its own output; this
 * just forwards to the binding.
 */
export class WorkersAiClient implements IWorkersAiClient {
	private readonly binding: Ai;

	constructor(env: EnvStore) {
		this.binding = env.binding<Ai>('AI');
	}

	run(...args: Parameters<Ai['run']>): ReturnType<Ai['run']> {
		return this.binding.run(...args);
	}
}

/** Built fresh per call, same as `gates()` — the binding itself is cheap to wrap, nothing to
 *  isolate-cache. */
export function workersAi(): WorkersAiClient {
	return new WorkersAiClient(envStore());
}
