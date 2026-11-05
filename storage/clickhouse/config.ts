import type { ClickHouseSettings } from './schema';

const REQUEST_TIMEOUT_MS = 60_000;

/** Settings applied to every request. `max_execution_time` is the server-side twin of the client's
 *  request timeout (ms → whole seconds); `max_threads` caps per-query parallelism so one heavy scan
 *  can't monopolise the cluster — a genuinely heavy read raises it via a per-query `.settings()`. */
export function defaultReadSettings(requestTimeoutMs = REQUEST_TIMEOUT_MS): ClickHouseSettings {
	return {
		max_execution_time: Math.ceil(requestTimeoutMs / 1000),
		max_threads: 8,
	};
}
