import type { UserConfig } from 'vite';

export type AppViteOptions = {
	/** Vite's cache directory, if not the default. */
	cacheDir?: string;
	/** Extra CSP sources per directive, added to the shared base (e.g. `'img-src': ['https://images.example.com']`). */
	csp?: false | Record<string, string[]>;
	/** `@zeyolabs/*` packages the app uses, kept out of Vite's pre-bundler. Default `['kit', 'ui']`. */
	packages?: string[];
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
