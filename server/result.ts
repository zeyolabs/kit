/**
 * A deliberate application outcome returned from a handler at HTTP 200: a success or a soft
 * failure (e.g. "not found", "out of stock"). Distinct from `ServiceError`, which is a real HTTP
 * error status. Handlers express business outcomes with `Ok`/`Fail`; they do not throw `Error4XX`.
 */
export class AppResult<T = unknown> {
	constructor(
		readonly ok: boolean,
		readonly message?: string,
		readonly data?: T
	) {}
}

/** A success outcome. */
export const Ok = <T>(data?: T, message?: string) => new AppResult<T>(true, message, data);

/** A soft failure; `data` may carry detail (e.g. fields). */
export const Fail = <T>(message: string, data?: T) => new AppResult<T>(false, message, data);
