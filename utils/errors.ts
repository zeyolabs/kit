import { HttpStatus } from './http-status';

/**
 * An error carrying an HTTP status and message, with no framework types. Callers map it to their
 * own response representation. An optional structured `body` overrides the default `{ error }`
 * payload, e.g. a validation failure that returns field-level errors.
 */
export class ServiceError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly body?: Record<string, unknown>
	) {
		super(message);
		this.name = 'ServiceError';
	}
}

export const Error400 = (message: string) => new ServiceError(HttpStatus.BadRequest, message);
export const Error401 = (message: string) => new ServiceError(HttpStatus.Unauthorized, message);
export const Error402 = (message: string) => new ServiceError(HttpStatus.PaymentRequired, message);
export const Error403 = (message: string) => new ServiceError(HttpStatus.Forbidden, message);
export const Error404 = (message: string) => new ServiceError(HttpStatus.NotFound, message);
/** The request contradicts the resource's current state. */
export const Error409 = (message: string) => new ServiceError(HttpStatus.Conflict, message);
/** Request validation failure; `body` carries the structured (field-level) errors. */
export const ErrorFields = (body: Record<string, unknown>, message = 'Validation failed') =>
	new ServiceError(HttpStatus.BadRequest, message, body);
/** Use for rate-limit rejections. */
export const Error429 = (message: string) => new ServiceError(HttpStatus.TooManyRequests, message);
/** A deliberate 500 (config/invariant failure). */
export const Error500 = (message: string) =>
	new ServiceError(HttpStatus.InternalServerError, message);
/** Use when a required dependency is down (fail closed). */
export const Error503 = (message: string) =>
	new ServiceError(HttpStatus.ServiceUnavailable, message);

/**
 * Map any thrown value to a client-safe HTTP status + message. A `ServiceError` carries its own
 * status/message (a deliberate, client-facing failure). Anything else is unexpected and collapses
 * to a generic 500; its message is never surfaced. `expected` lets callers pick the log level.
 */
export function toHttpError(err: unknown): {
	body?: Record<string, unknown>;
	expected: boolean;
	message: string;
	status: number;
} {
	if (err instanceof ServiceError) {
		return { body: err.body, expected: true, message: err.message, status: err.status };
	}
	return {
		expected: false,
		message: 'Internal server error',
		status: HttpStatus.InternalServerError,
	};
}

/** Extract an HTTP status from an unknown thrown value, or null if it has none. */
export function getHttpStatus(error: unknown): null | number {
	if (typeof error !== 'object' || error === null) return null;
	const e = error as { body?: { code?: string }; status?: number | string; statusCode?: number };
	const status = e.status ?? e.statusCode;
	if (typeof status === 'number') return status;
	if (status === 'BAD_REQUEST' || e.body?.code === 'BAD_REQUEST') return 400;
	return null;
}
