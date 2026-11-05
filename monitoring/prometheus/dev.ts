import type { IPrometheusClient, PrometheusSample } from './client';

/** Stands in for `PrometheusClient` where there's no `PROMETHEUS_VPC` binding to push to (local
 *  dev) — logs instead of sending, so metrics are still visible without a real Prometheus. */
export class DevPrometheusClient implements IPrometheusClient {
	async push(...samples: PrometheusSample[]): Promise<void> {
		this.log(samples);
	}

	pushAndForget(...samples: PrometheusSample[]): void {
		this.log(samples);
	}

	async pushWithRetry(_attempts?: number, ...samples: PrometheusSample[]): Promise<void> {
		this.log(samples);
	}

	private log(samples: PrometheusSample[]): void {
		for (const s of samples) {
			console.log(`[prometheus:dev] ${s.name} ${s.value}`, s.labels ?? {});
		}
	}
}
