import { create, toBinary } from '@bufbuild/protobuf';
import * as snappy from 'snappyjs';

// Direct push into Prometheus over a VPC-style binding (Workers VPC, no public host). No ambient
// context, no app-specific knowledge — the binding + credentials are passed in.
import { waitUntil } from '../../cloudflare/wait-until';
import { WriteRequestSchema } from './gen/remote_write_pb';

export type PrometheusSample = {
	labels?: Record<string, string>;
	name: string;
	timestampMs?: number;
	value: number;
};

/** Just the shape callers depend on — a test can hand-write a fake object matching this
 *  (`{ push: vi.fn(), pushAndForget: vi.fn(), pushWithRetry: vi.fn() }`) instead of constructing
 *  `PrometheusClient` with a fake `vpc.fetch`. */
export interface IPrometheusClient {
	push(...samples: PrometheusSample[]): Promise<void>;
	pushAndForget(...samples: PrometheusSample[]): void;
	pushWithRetry(attempts?: number, ...samples: PrometheusSample[]): Promise<void>;
}

export type PrometheusConfig = {
	password: string;
	user: string;
	/** The resolved Workers VPC Service binding — the caller reads it off its own `EnvStore`
	 *  (`env.vpc('PROMETHEUS_VPC')`), not a binding name for this client to look up itself. */
	vpc: Fetcher;
};

/** The real implementation — pushes over Prometheus's remote-write protocol. Construct directly
 *  via `new PrometheusClient(config)`. */
export class PrometheusClient implements IPrometheusClient {
	constructor(private readonly config: PrometheusConfig) {}

	/** Zero samples is a real no-op (nothing to push). */
	async push(...samples: PrometheusSample[]): Promise<void> {
		if (samples.length === 0) return;
		const { password, user, vpc } = this.config;

		const now = BigInt(Date.now());
		const writeRequest = create(WriteRequestSchema, {
			timeseries: samples.map((s) => ({
				labels: [
					{ name: '__name__', value: s.name },
					...Object.entries(s.labels ?? {}).map(([name, value]) => ({ name, value })),
				],
				samples: [
					{ timestamp: s.timestampMs != null ? BigInt(s.timestampMs) : now, value: s.value },
				],
			})),
		});

		const res = await vpc.fetch('http://localhost/api/v1/write', {
			body: snappy.compress(toBinary(WriteRequestSchema, writeRequest)),
			headers: {
				Authorization: `Basic ${btoa(`${user}:${password}`)}`,
				'Content-Encoding': 'snappy',
				'Content-Type': 'application/x-protobuf',
				'X-Prometheus-Remote-Write-Version': '0.1.0',
			},
			method: 'POST',
		});

		if (!res.ok) {
			throw new Error(
				`PrometheusClient.push: Prometheus returned ${res.status}: ${await res.text()}`
			);
		}
	}

	/** Swallow-and-log — a Prometheus outage must never block the caller's own critical path.
	 *  Extends its own lifetime past the caller's response where that's possible (the real
	 *  Workers runtime), since without it the platform can kill this push mid-flight the moment
	 *  the caller's own response has been sent. */
	pushAndForget(...samples: PrometheusSample[]): void {
		if (samples.length === 0) return;
		const result = this.push(...samples).catch((error) => {
			console.warn('metrics push failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		});
		void waitUntil(result);
	}

	/** Retries with exponential backoff + jitter instead of swallowing — for a caller that needs
	 *  the push to land. Still throws after exhausting `attempts`. */
	async pushWithRetry(attempts = 3, ...samples: PrometheusSample[]): Promise<void> {
		if (samples.length === 0) return;
		for (let i = 0; ; i++) {
			try {
				return await this.push(...samples);
			} catch (error) {
				if (i >= attempts - 1) throw error;
				const backoff = 2 ** i * 100 + Math.random() * 100;
				await new Promise((resolve) => setTimeout(resolve, backoff));
			}
		}
	}
}

// Metric-type-shaped `PrometheusSample` builders — thin naming-convention wrappers, not real
// client-side accumulation (a Worker invocation is stateless; every call is one point-in-time
// observation the caller already computed). `bucket`/`sum` apply the `_bucket`/`_sum` suffixes
// Prometheus's histogram functions (`histogram_quantile`, `rate`) require to find the right
// series — `le` is the caller's own bucket boundary, folded into labels as a string (`"+Inf"` is
// a valid value for the top bucket). `count` does NOT auto-suffix `_total` — unlike `_bucket`/
// `_sum`, that's a naming convention `rate()`/`increase()` don't require, so it stays opt-in.

export function bucket(
	name: string,
	le: number | string,
	value: number,
	labels?: Record<string, string>,
	timestampMs?: number
): PrometheusSample {
	return { labels: { ...labels, le: String(le) }, name: `${name}_bucket`, timestampMs, value };
}

export function count(
	name: string,
	value: number,
	labels?: Record<string, string>,
	timestampMs?: number
): PrometheusSample {
	return { labels, name, timestampMs, value };
}

export function gauge(
	name: string,
	value: number,
	labels?: Record<string, string>,
	timestampMs?: number
): PrometheusSample {
	return { labels, name, timestampMs, value };
}

export function sum(
	name: string,
	value: number,
	labels?: Record<string, string>,
	timestampMs?: number
): PrometheusSample {
	return { labels, name: `${name}_sum`, timestampMs, value };
}
