/// <reference types="vite/client" />
import type { HandleClientError } from '@sveltejs/kit/hooks';

import { dev } from '$app/env';
import { SENTRY_DSN } from '$app/env/public';
import { updated } from '$app/state';
import * as SentrySdk from '@sentry/sveltekit';

import { type AppSentryOptions, SentryConfig } from './sentry';

/** Needs `SENTRY_DSN` (public, static) in the app's src/env.ts. */
export const Sentry = {
	client({ service }: AppSentryOptions = {}) {
		SentrySdk.init(
			SentryConfig.options({
				dev,
				dsn: SENTRY_DSN,
				environment: import.meta.env.MODE,
				service,
				updated,
			})
		);
	},

	clientErrors(): HandleClientError {
		return SentryConfig.clientErrors(SentrySdk.handleErrorWithSentry());
	},
};
