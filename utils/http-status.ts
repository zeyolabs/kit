export const SuccessCode = {
	Accepted: 202, // Request accepted but not yet processed. Use for async/queued operations.
	Created: 201, // Resource was created. Use for POST requests that result in a new resource.
	NoContent: 204, // Success with no body to return. Use for DELETE or actions with no response data.
	OK: 200, // Standard success. Use for GET, PUT, or PATCH requests that return a body.
} as const;

export const RedirectCode = {
	Found: 302, // Temporary redirect. Client should continue using the original URL.
	MovedPermanently: 301, // Resource has permanently moved. Clients should update their bookmarks.
	PermanentRedirect: 308, // Permanent redirect preserving the original HTTP method.
	SeeOther: 303, // Redirect to a different resource, always with GET. Use after POST to prevent re-submission.
	TemporaryRedirect: 307, // Temporary redirect preserving the original HTTP method.
} as const;

export const ClientErrorCode = {
	BadRequest: 400, // Malformed request syntax or invalid parameters.
	Conflict: 409, // Request conflicts with the current state (e.g. duplicate resource).
	Forbidden: 403, // Authenticated but not authorised to access this resource.
	Gone: 410, // Resource permanently deleted and no longer available.
	MethodNotAllowed: 405, // HTTP method is not supported for this endpoint.
	NotFound: 404, // Resource does not exist.
	PaymentRequired: 402, // Payment is required to access this resource.
	TooManyRequests: 429, // Rate limit exceeded.
	Unauthorized: 401, // Authentication required or credentials are invalid.
	UnprocessableEntity: 422, // Request is well-formed but contains semantic errors.
} as const;

export const ServerErrorCode = {
	BadGateway: 502, // Upstream service returned an invalid response.
	GatewayTimeout: 504, // Upstream service did not respond in time.
	InternalServerError: 500, // Unexpected server-side failure.
	NotImplemented: 501, // Endpoint or feature not yet implemented.
	ServiceUnavailable: 503, // Server is temporarily unavailable (overloaded or down for maintenance).
} as const;

export const HttpStatus = {
	...SuccessCode,
	...RedirectCode,
	...ClientErrorCode,
	...ServerErrorCode,
} as const;
