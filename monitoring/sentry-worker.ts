import * as SentrySdk from '@sentry/cloudflare';

import { SentryConfig } from './sentry';

type SentryEnv = { SENTRY_DSN?: string; SENTRY_RELEASE?: string };
type WorkerSentryOptions = { service?: string };

const optionsFor =
	({ service }: WorkerSentryOptions) =>
	(env: SentryEnv) =>
		SentryConfig.options({ dev: false, dsn: env.SENTRY_DSN, release: env.SENTRY_RELEASE, service });

export const Sentry = {
	capture: SentrySdk.captureException,

	durableObject<C extends Parameters<typeof SentrySdk.instrumentDurableObjectWithSentry>[1]>(
		options: WorkerSentryOptions,
		durableObjectClass: C
	): C {
		return SentrySdk.instrumentDurableObjectWithSentry(
			optionsFor(options) as never,
			durableObjectClass
		);
	},

	worker<T extends Parameters<typeof SentrySdk.withSentry>[1]>(
		options: WorkerSentryOptions,
		handler: T
	): T {
		return SentrySdk.withSentry(optionsFor(options) as never, handler);
	},
};
