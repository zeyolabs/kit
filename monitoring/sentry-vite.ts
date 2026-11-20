import type { Plugin } from 'vite';

const OTEL_API = '@opentelemetry/api';
const SENTRY_OTEL_API = '@sentry/sveltekit/opentelemetry-api';
const SENTRY_OTEL_API_FILE = /[\\/]opentelemetryApi\.js$/;

/** Vite plugins for apps that use `@sentry/sveltekit` on Cloudflare Workers. */
export const SentryVite = {
	/**
	 * `@sentry/sveltekit` rewrites the SvelteKit server's `@opentelemetry/api` import into an external
	 * `@sentry/sveltekit/opentelemetry-api`, expecting node_modules at runtime. A Worker built by
	 * adapter-cloudflare 9 has none, so every request fails with "No such module". This resolves the
	 * import to Sentry's re-export file so it is bundled. List it before `sentrySvelteKit()`.
	 */
	bundleOpenTelemetry(): Plugin {
		return {
			apply: 'build',
			enforce: 'pre',
			name: 'zeyolabs-bundle-opentelemetry-api',
			resolveId(id, importer, options) {
				if (id !== OTEL_API || !options?.ssr) return null;
				if (importer && SENTRY_OTEL_API_FILE.test(importer)) return null;
				return this.resolve(SENTRY_OTEL_API, importer, { skipSelf: true });
			},
		};
	},
};
