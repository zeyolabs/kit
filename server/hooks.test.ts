import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/server', () => ({ command: vi.fn(), form: vi.fn(), query: vi.fn() }));
vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));

const { AppHooks } = await import('./hooks');
const { logger } = await import('./logger');

type ErrorInput = Parameters<ReturnType<typeof AppHooks.serverErrors>>[0];
type HandleInput = Parameters<ReturnType<typeof AppHooks.securityHeaders>>[0];

const request = new Request('https://app.test/_app/remote/abc/getThing');
const errorInput = (fields: Record<string, unknown>) =>
	({ event: { request, url: new URL(request.url) }, ...fields }) as unknown as ErrorInput;

describe('AppHooks.serverErrors', () => {
	const report = vi.fn();
	const handle = AppHooks.serverErrors(report);

	it('logs validation failures with the function name, without reporting', () => {
		handle(errorInput({ issues: [{ message: 'Required', path: ['id'] }], kind: 'validation' }));
		expect(logger.error).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('abc/getThing') }),
			expect.anything()
		);
		expect(report).not.toHaveBeenCalled();
	});

	it('answers a forged form post with 400', () => {
		const error = new Error('Bad field https://svelte.dev/e/kit/form_field_unexpected');
		expect(handle(errorInput({ error, kind: 'unknown' }))).toEqual({
			message: 'Bad request',
			status: 400,
		});
	});

	it('drops expected 4xx and reports the rest', () => {
		handle(errorInput({ error: { status: 404 }, kind: 'error' }));
		expect(report).not.toHaveBeenCalled();
		handle(errorInput({ error: new Error('boom'), kind: 'unknown' }));
		expect(report).toHaveBeenCalledTimes(1);
	});
});

describe('AppHooks.securityHeaders', () => {
	const run = (isPrivate: boolean, response: Response) =>
		AppHooks.securityHeaders({ private: isPrivate })({
			event: {},
			resolve: async () => response,
		} as unknown as HandleInput) as Promise<Response>;

	it('keeps a private app out of caches and search engines', async () => {
		const headers = (await run(true, new Response('ok'))).headers;
		expect(headers.get('Cache-Control')).toBe('private, no-store');
		expect(headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
		expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
	});

	it('leaves caching to a public site', async () => {
		const headers = (await run(false, new Response('ok'))).headers;
		expect(headers.get('Cache-Control')).toBeNull();
		expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
	});

	it('copies a response whose headers are immutable', async () => {
		const immutable = Response.redirect('https://app.test/', 302);
		const out = await run(true, immutable);
		expect(out.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});
