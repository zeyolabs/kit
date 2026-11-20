import type { HandleClientError } from '@sveltejs/kit/hooks';

type ScrubbableEvent = {
	request?: {
		cookies?: unknown;
		data?: unknown;
		headers?: Record<string, string>;
		query_string?: unknown;
		url?: string;
	};
	tags?: Record<string, unknown>;
};

export type SentryOptionsInput = {
	/** Dev builds init the SDK, so instrumentation is wired, but send nothing. */
	dev: boolean;
	dsn: string | undefined;
	release?: string;
	/** Tags every event, for a project shared by several workers. */
	service?: string;
};

// Loopback only, never `*.workers.dev`: `wrangler dev` serves a production build, so the host is
// the only sign an event came from a local run.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;
const SECRET_HEADER = /^(authorization|cf-access-jwt-assertion|cookie|set-cookie)$/i;

function isLocal(url: string | undefined): boolean {
	if (!url) return false;
	try {
		return LOCAL_HOST.test(new URL(url).host);
	} catch {
		return false;
	}
}

/** Drops request bodies, cookies, query strings and auth headers. */
function scrub<T extends ScrubbableEvent>(event: T): T {
	const request = event.request;
	if (!request) return event;
	delete request.data;
	delete request.cookies;
	delete request.query_string;
	if (request.headers) {
		for (const name of Object.keys(request.headers)) {
			if (SECRET_HEADER.test(name)) delete request.headers[name];
		}
	}
	if (request.url) request.url = request.url.split(/[?#]/)[0] ?? request.url;
	return event;
}

/**
 * Sentry v11 collects nothing personal with these: no user info, cookies, headers, query strings,
 * bodies, query data, queue arguments or local variables.
 */
const dataCollection = {
	cookies: false,
	databaseQueryData: false,
	httpBodies: [] as never[],
	httpHeaders: false,
	queues: false,
	stackFrameVariables: false,
	urlQueryParams: false,
	userInfo: false,
};

/**
 * The Sentry setup every app shares: `Sentry.init(SentryConfig.options({ dsn, dev }))` in the
 * client hooks, `initCloudflareSentryHandle(...)` on the server.
 */
export const SentryConfig = {
	/** A client `handleError` that reports only unexpected errors: SvelteKit 3 also sends expected
	 *  ones (a 404 page, `error(404)` from a query) through it. */
	clientErrors(report: HandleClientError): HandleClientError {
		return (input) => {
			if (input.kind !== 'unknown' && input.error.status < 500) return;
			return report(input);
		};
	},

	options({ dev, dsn, release, service }: SentryOptionsInput) {
		const beforeSend = <T extends ScrubbableEvent>(event: T): null | T => {
			if (isLocal(event.request?.url)) return null;
			if (service) event.tags = { ...event.tags, service };
			return scrub(event);
		};
		return {
			beforeSend,
			beforeSendTransaction: beforeSend,
			dataCollection,
			dsn,
			enabled: !dev && Boolean(dsn),
			environment: dev ? 'development' : 'production',
			...(service ? { initialScope: { tags: { service } } } : {}),
			release,
			tracesSampleRate: 0.1,
		};
	},
};
