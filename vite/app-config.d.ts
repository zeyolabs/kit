import type { UserConfig } from 'vite';

export type AppViteOptions = {
	/** Extra CSP sources per directive, added to the shared base (e.g. `'img-src': ['https://images.example.com']`). */
	csp?: Record<string, string[]>;
	/** `@zeyolabs/*` packages the app uses, kept out of Vite's pre-bundler. Default `['kit', 'ui']`. */
	packages?: string[];
	/** Dev server port (strict). */
	port: number;
	/** Sentry project slug in the `zeyo` org. */
	sentryProject: string;
	/** Vitest picks up `src/**\/*.test.ts`. Default true. */
	test?: boolean;
	/** Allow the Cloudflare Turnstile widget (script and frame). */
	turnstile?: boolean;
};

export declare const AppVite: {
	config(options: AppViteOptions): UserConfig & { test?: { include: string[] } };
	csp(options: Pick<AppViteOptions, 'csp' | 'turnstile'>): Record<string, string[]>;
};
