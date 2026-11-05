import type { IPrometheusClient, PrometheusSample } from './client';

/** Records every sample passed to `push`/`pushAndForget`/`pushWithRetry` instead of sending
 *  anything — for asserting what a service pushed, without a mock `vpc.fetch`. */
export class FakePrometheusClient implements IPrometheusClient {
	readonly pushed: PrometheusSample[] = [];

	async push(...samples: PrometheusSample[]): Promise<void> {
		this.pushed.push(...samples);
	}

	pushAndForget(...samples: PrometheusSample[]): void {
		this.pushed.push(...samples);
	}

	async pushWithRetry(_attempts?: number, ...samples: PrometheusSample[]): Promise<void> {
		this.pushed.push(...samples);
	}
}
