import type { z } from 'zod';

import {
	command,
	form,
	query,
	type RemoteCommand,
	type RemoteForm,
	type RemoteFormInput,
	type RemoteQueryFunction,
} from '$app/server';
import { error, isHttpError, type RequestEvent } from '@sveltejs/kit';

import { ServiceError, toHttpError } from '../utils/errors';
import { FormResult } from '../utils/form';
import { HttpStatus } from '../utils/http-status';
import { logger } from './logger';
import { AppResult } from './result';

/**
 * Remote-function wrappers, the `$app/server` counterpart to a plain API route. They mirror the
 * `$app/server` `query`/`command`/`form` signatures (optional input `schema` first, `run` second)
 * and add shared error handling:
 *
 *   export const getTags  = Remote.Query(() => listTags());
 *   export const find     = Remote.Query(FooSchema, (data) => find(data));
 *   export const saveForm = Remote.Form(SaveSchema, (data) => save(data));
 *
 * Failures are funnelled into each kind's error channel:
 * - a thrown `ServiceError` (`Error400`/`Error404`/...) or a raw SvelteKit `error(status, message)`
 *   is a deliberate, client-facing failure: it keeps its status and is not reported;
 * - a thrown `Fail` (`AppResult` with `ok: false`, a soft business failure) surfaces its message
 *   (a `Query`/`Cmd` reports it at 400; a `Form` shows it inline);
 * - anything else is unexpected and logged; a `Query`/`Cmd` collapses it to a generic 500 (its
 *   message is never surfaced), a `Form` still returns an inline `FormResult.err(...)` with a
 *   generic message (throwing would break `<Form>`).
 */

/** A thrown `Fail` (`AppResult` with `ok: false`) carries a client-safe message: surface it. */
function isFail(e: unknown): e is AppResult {
	return e instanceof AppResult && !e.ok;
}

/** Map a thrown value to a SvelteKit HttpError: Fail at 400, ServiceError/HttpError keep their status, else 500. */
function throwAsHttp(e: unknown): never {
	if (isFail(e)) throw error(HttpStatus.BadRequest, e.message ?? 'Request failed');
	if (isHttpError(e)) throw e;
	const { expected, message, status } = toHttpError(e);
	if (!expected) logger.error(e, { op: 'remote' });
	throw error(status, message);
}

/** Wrap a run fn so any thrown value funnels through `throwAsHttp` (Query/Cmd error channel). */
function errorGuard(run: (input?: unknown) => Promise<unknown>) {
	return async (input?: unknown) => {
		try {
			return await run(input);
		} catch (e) {
			throwAsHttp(e);
		}
	};
}

function remoteQuery<O>(run: () => Promise<O>): RemoteQueryFunction<void, O>;
function remoteQuery<S extends z.ZodType, O>(
	schema: S,
	run: (input: z.infer<S>) => Promise<O>
): RemoteQueryFunction<z.input<S>, O, z.infer<S>>;
function remoteQuery(
	schemaOrRun: ((input?: unknown) => Promise<unknown>) | z.ZodType,
	maybeRun?: (input?: unknown) => Promise<unknown>
) {
	const schema = maybeRun ? (schemaOrRun as z.ZodType) : undefined;
	const run = errorGuard((maybeRun ?? schemaOrRun) as (input?: unknown) => Promise<unknown>);
	return schema ? query(schema, run) : query(run);
}

function remoteCommand<O>(run: () => Promise<O>): RemoteCommand<void, O>;
function remoteCommand<S extends z.ZodType, O>(
	schema: S,
	run: (input: z.infer<S>) => Promise<O>
): RemoteCommand<z.input<S>, O>;
function remoteCommand(
	schemaOrRun: ((input?: unknown) => Promise<unknown>) | z.ZodType,
	maybeRun?: (input?: unknown) => Promise<unknown>
) {
	const schema = maybeRun ? (schemaOrRun as z.ZodType) : undefined;
	const run = errorGuard((maybeRun ?? schemaOrRun) as (input?: unknown) => Promise<unknown>);
	return schema ? command(schema, run) : command(run);
}

function remoteForm<S extends z.ZodType, O>(
	schema: S,
	run: (input: z.infer<S>) => Promise<O>
): RemoteForm<RemoteFormInput, O> {
	const wrapped = async (data: z.infer<S>) => {
		try {
			return await run(data);
		} catch (e) {
			// A ServiceError (expired link, email in use, ...), a soft Fail, or a directly-thrown
			// HttpError becomes an inline form error; anything else is unexpected but still becomes an
			// inline error, because throwing here would break `<Form>`.
			if (e instanceof ServiceError) return FormResult.err(e.message);
			if (isFail(e)) return FormResult.err(e.message);
			if (isHttpError(e)) return FormResult.err(e.body.message);
			logger.error(e, { op: 'remote' });
			return FormResult.err('Something went wrong. Please try again.');
		}
	};
	return form(schema as never, wrapped as never) as unknown as RemoteForm<RemoteFormInput, O>;
}

export const Remote = {
	Cmd: remoteCommand,
	Form: remoteForm,
	Query: remoteQuery,
};

/**
 * Logs a remote-function schema validation failure from `handleError` (`kind: 'validation'`).
 * SvelteKit's default names neither the function nor the field, which makes a production failure
 * untraceable; this logs the remote function id plus each issue's field path and message.
 */
export function logRemoteValidation(
	event: RequestEvent,
	issues: readonly { message: string; path?: readonly (PropertyKey | { key: PropertyKey })[] }[]
): void {
	// `event.url` is rewritten to the calling page's URL inside remote calls: the remote endpoint
	// (`.../remote/<hash>/<name>`) only survives on the raw request.
	const pathname = new URL(event.request.url).pathname;
	const fn = pathname.split('/remote/')[1] ?? pathname;
	logger.error(new Error(`remote function schema validation failed: ${fn}`), {
		issues: issues.map((i) => ({
			message: i.message,
			path: i.path?.map((s) => String(typeof s === 'object' && s !== null ? s.key : s)).join('.'),
		})),
		op: 'remote-validation',
	});
}
