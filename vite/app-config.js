import { sentrySvelteKit } from '@sentry/sveltekit/vite';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';

import { SentryVite } from '../monitoring/sentry-vite.js';

const TURNSTILE = 'https://challenges.cloudflare.com';

/** Content-Security-Policy every app starts from: its own origin, Sentry and the Google web font. */
const BASE_CSP = {
	'base-uri': ['self'],
	'connect-src': ['self', 'https://*.ingest.de.sentry.io'],
	'default-src': ['self'],
	'font-src': ['https://fonts.gstatic.com'],
	'form-action': ['self'],
	'frame-ancestors': ['none'],
	'img-src': ['self', 'data:'],
	'object-src': ['none'],
	'script-src': ['self'],
	'style-src': ['self', 'unsafe-inline', 'https://fonts.googleapis.com'],
};

/**
 * The Vite config of a SvelteKit app on Cloudflare Workers with `@zeyolabs/*`: Sentry (source maps
 * uploaded from CI only), Tailwind, adapter-cloudflare with the repo-wide local D1, async Svelte,
 * remote functions and a nonce-based CSP. Apps pass only what differs.
 */
export const AppVite = {
	/** @param {import('./app-config').AppViteOptions} options */
	config({
		cacheDir,
		csp = {},
		packages = ['kit', 'ui'],
		port,
		sentryOrg = 'zeyo',
		sentryProject,
		test = true,
		turnstile = false,
	}) {
		const directives = csp === false ? null : AppVite.csp({ csp, turnstile });

		return {
			...(cacheDir ? { cacheDir } : {}),
			build: {
				rollupOptions: {
					external: ['cloudflare:sockets', 'cloudflare:email', 'cloudflare:workers'],
				},
			},
			// The pre-bundler can't parse the TypeScript in their .svelte.ts files.
			optimizeDeps: { exclude: packages.map((name) => `@zeyolabs/${name}`) },
			plugins: [
				SentryVite.bundleOpenTelemetry(),
				sentrySvelteKit({
					// SENTRY_AUTH_TOKEN is set in CI only; without it the source-map upload is skipped.
					authToken: process.env.SENTRY_AUTH_TOKEN,
					// Build-time instrumentation breaks some Workers runtime code paths.
					buildTimeInstrumentation: false,
					org: sentryOrg,
					project: sentryProject,
					// Only the public client maps: the Worker's go to Cloudflare with the deploy.
					sourcemaps: {
						filesToDeleteAfterUpload: [
							'./.svelte-kit/cloudflare/client/**/*.map',
							'./.svelte-kit/output/client/**/*.map',
						],
					},
					telemetry: false,
				}),
				tailwindcss(),
				sveltekit({
					adapter: adapter({
						platformProxy: {
							configPath: 'wrangler.jsonc',
							// Tests start this proxy too; parallel test runs would lock one shared local database.
							persist: process.env.VITEST ? false : { path: '../../.wrangler/state/v3' },
						},
					}),
					compilerOptions: { experimental: { async: true } },
					// `mode: 'auto'` adds nonces (SSR) / hashes (prerendered) to SvelteKit's inline scripts.
					...(directives ? { csp: { directives, mode: 'auto' } } : {}),
					experimental: { remoteFunctions: true },
					preprocess: vitePreprocess(),
					version: { pollInterval: 300_000 },
				}),
			],
			// @sveltejs/kit dual-instance fix
			resolve: { dedupe: ['@sveltejs/kit'] },
			server: { port, strictPort: true },
			...(test ? { test: { include: ['src/**/*.test.ts'] } } : {}),
		};
	},

	/**
	 * The CSP directives: the shared base, Turnstile's sources when asked, then the app's extras.
	 * @param {{ csp?: Record<string, string[]>; turnstile?: boolean }} options
	 * @returns {Record<string, string[]>}
	 */
	csp({ csp = {}, turnstile = false }) {
		/** @type {Record<string, string[]>} */
		const directives = Object.fromEntries(
			Object.entries(BASE_CSP).map(([key, sources]) => [key, [...sources]])
		);
		const add = (/** @type {Record<string, string[]>} */ extra) => {
			for (const [key, sources] of Object.entries(extra)) {
				directives[key] = [...(directives[key] ?? []), ...sources];
			}
		};
		if (turnstile) add({ 'frame-src': [TURNSTILE], 'script-src': [TURNSTILE] });
		add(csp);
		return directives;
	},
};
