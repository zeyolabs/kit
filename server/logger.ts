import { captureException } from '@sentry/sveltekit';

// Drizzle (and other wrappers) bury the real failure in `error.cause`. Surface the whole chain so
// logs show the actual cause, not just "Failed query".
export function causeChain(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	for (
		let depth = 0;
		depth < 5 && current && typeof current === 'object' && 'cause' in current;
		depth++
	) {
		current = (current as { cause: unknown }).cause;
		if (!current || typeof current !== 'object') break;
		const info = current as { code?: unknown; detail?: unknown; message?: unknown };
		const code = info.code ? `[${String(info.code)}] ` : '';
		const detail = info.detail ? ` | detail: ${String(info.detail)}` : '';
		parts.push(`${code}${String(info.message ?? current)}${detail}`);
	}
	return parts.join(' <- ');
}

// `console.error(error)` serializes lossily in Workers log capture: pull message/name/code/cause
// into the logged context explicitly so they survive.
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

/** A `context.tags` key is Sentry tag data (grouping/filtering); the rest becomes extra data. */
function reportToSentry(error: unknown, context?: Record<string, unknown>): void {
	const { tags, ...extra } = context ?? {};
	captureException(error, { extra, tags: tags as Record<string, string> | undefined });
}

/**
 * `warn`/`error` always fire: both are reserved for genuinely abnormal conditions, so volume stays
 * near zero normally and rises only during a real incident. `debug` is for temporary investigation:
 * add a call while chasing a bug and delete it once resolved.
 */
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

export const logger = new LoggerClient();
