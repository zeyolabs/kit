import type { KitConfig } from '@sveltejs/kit';
import type { PluginOption, UserConfig } from 'vite';

export type AppViteOptions = {
	/** Extra CSP sources per directive, added to the shared base (e.g. `'img-src': ['https://images.example.com']`). */
	csp?: Record<string, string[]>;
	/** Extra SvelteKit options, applied over the shared ones (e.g. `files: { assets: '../web/static' }`). */
	kit?: KitConfig;
	/** `@zeyolabs/*` packages the app uses, kept out of Vite's pre-bundler. Default `['kit', 'ui']`. */
	packages?: string[];
	/** The app's own Vite plugins, run before SvelteKit's (e.g. `enhancedImages()`). */
	plugins?: PluginOption[];
	/** Dev server port (strict). */
	port: number;
	/** Sentry organisation slug. */
	sentryOrg: string;
	/** Sentry project slug. */
	sentryProject: string;
	/** Vitest picks up `src/**\/*.test.ts`. Default true. */
	test?: boolean;
	/** Allow the Cloudflare Turnstile widget (script and frame). */
	turnstile?: boolean;
};

export declare const AppVite: {
	config(options: AppViteOptions): UserConfig & { test?: { include: string[] } };
	csp(options: { csp?: Record<string, string[]>; turnstile?: boolean }): Record<string, string[]>;
};
