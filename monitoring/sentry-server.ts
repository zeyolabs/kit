/// <reference types="vite/client" />
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';

import { dev } from '$app/env';
import { SENTRY_DSN } from '$app/env/public';
import { handleErrorWithSentry, initCloudflareSentryHandle, sentryHandle } from '@sentry/sveltekit';
import { sequence } from '@sveltejs/kit/hooks';

import { AppHooks } from '../server/hooks';
import { type AppSentryOptions, SentryConfig } from './sentry';

declare const SENTRY_RELEASE: undefined | { id?: string };

/** Needs `SENTRY_DSN` (public, static) in the app's src/env.ts. */
export const Sentry = {
	/** First in `handle`'s `sequence`, so failures in later hooks are reported. */
	serverHandle({ service }: AppSentryOptions = {}): Handle {
		return sequence(
			initCloudflareSentryHandle(
				SentryConfig.options({
					dev,
					dsn: SENTRY_DSN,
					environment: import.meta.env.MODE,
					// The Cloudflare handler doesn't pick up the release the Sentry build plugin injects.
					release: typeof SENTRY_RELEASE !== 'undefined' ? SENTRY_RELEASE?.id : undefined,
					service,
				})
			),
			sentryHandle()
		);
	},

	serverHandleError(): HandleServerError {
		return AppHooks.serverErrors(handleErrorWithSentry(AppHooks.logError));
	},
};
