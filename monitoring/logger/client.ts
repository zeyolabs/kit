import { captureException } from '@sentry/cloudflare';

// Drizzle (and other wrappers) bury the real failure in `error.cause` — e.g. a pg error like
// `[28P01] password authentication failed` or `[42501] permission denied`. Surface the whole
// chain so logs show the actual cause, not just "Failed query".
export function causeChain(error: unknown): string {
	const parts: string[] = [];
	let e: unknown = error;
	for (let depth = 0; depth < 5 && e && typeof e === 'object' && 'cause' in e; depth++) {
		e = (e as { cause: unknown }).cause;
		if (!e || typeof e !== 'object') break;
		const x = e as { code?: unknown; detail?: unknown; message?: unknown };
		const code = x.code ? `[${String(x.code)}] ` : '';
		const detail = x.detail ? ` | detail: ${String(x.detail)}` : '';
		parts.push(`${code}${String(x.message ?? e)}${detail}`);
	}
	return parts.join(' <- ');
}

/** `console.error(error)`'s own serialization is lossy in Workers/CI log capture — pull
 *  `message`/`name`/`code` (the last from node-postgres and similar driver errors) into the
 *  logged context explicitly so they survive. `cause` walks wrapper errors (drizzle, etc) down
 *  to the real underlying error, which otherwise never surfaces at all. */
function errorDetails(error: unknown): Record<string, unknown> {
	if (!(error instanceof Error)) return { message: String(error) };
	const code = 'code' in error ? (error as { code: unknown }).code : undefined;
	const cause = causeChain(error);
	return {
		message: error.message,
		name: error.name,
		...(code !== undefined && { code }),
		...(cause && { cause }),
	};
}

/** A `context.tags` key (if present) is Sentry tag data (grouping/filtering) — peeled off here so
 *  every caller gets consistent tag/extra separation for free, rather than each host re-deriving
 *  this split in its own wiring (see the old per-host `logger.configure` callbacks this replaced). */
function reportToSentry(error: unknown, context?: Record<string, unknown>): void {
	const { tags, ...extra } = context ?? {};
	captureException(error, { extra, tags: tags as Record<string, string> | undefined });
}

/** `warn`/`error` always fire — both are reserved for genuinely abnormal conditions (not routine
 *  per-request narration), so there's nothing to gate: volume stays near-zero in normal operation
 *  and only rises during a real incident, which is exactly when more visibility is wanted, not
 *  less. `debug` is for active, temporary investigation only — add a call while chasing a
 *  specific bug, delete it once resolved; it's not a permanent narration/tracing tool, so it gets
 *  no gate either. */
export class LoggerClient {
	debug(message: string, context?: Record<string, unknown>): void {
		console.debug(`[DEBUG] ${message}`, ...(context ? [context] : []));
	}

	error(error: unknown, context?: Record<string, unknown>): void {
		console.error('[ERROR]', error, { ...errorDetails(error), ...context });
		reportToSentry(error, context);
	}

	warn(message: string, context?: Record<string, unknown>): void {
		console.warn(`[WARN] ${message}`, ...(context ? [context] : []));
	}
}

/** Process-wide logger singleton — Sentry reporting is self-contained, nothing to wire per host. */
export const logger = new LoggerClient();
