import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('AppHooks.pageCache', () => {
	const store = new Map<string, Response>();
	const cache = {
		match: vi.fn((key: Request) => Promise.resolve(store.get(key.url)?.clone())),
		put: vi.fn((key: Request, response: Response) => {
			store.set(key.url, response.clone());
			return Promise.resolve();
		}),
	};
	const rules = [
		{ exact: '/', seconds: 60 },
		{ prefix: '/category/', seconds: 120 },
	];
	const page = () =>
		new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });

	function run(path: string, init: { cookie?: string; method?: string } = {}) {
		const request = new Request(`https://shop.test${path}`, {
			headers: init.cookie ? { cookie: init.cookie } : {},
			method: init.method ?? 'GET',
		});
		const resolve = vi.fn(() => Promise.resolve(page()));
		const event = { request, url: new URL(request.url) };
		return {
			resolve,
			response: AppHooks.pageCache(rules)({ event, resolve } as unknown as HandleInput),
		};
	}

	beforeEach(() => {
		store.clear();
		cache.match.mockClear();
		cache.put.mockClear();
		vi.stubGlobal('caches', { default: cache });
	});
	afterEach(() => vi.unstubAllGlobals());

	it('renders once, then serves the stored copy', async () => {
		const first = run('/');
		expect((await first.response).headers.get('X-Page-Cache')).toBe('MISS');
		expect(first.resolve).toHaveBeenCalledOnce();
		expect(cache.put.mock.calls[0][1].headers.get('Cache-Control')).toBe('public, max-age=60');

		const second = run('/');
		const response = await second.response;
		expect(response.headers.get('X-Page-Cache')).toBe('HIT');
		expect(await response.text()).toBe('<html></html>');
		expect(second.resolve).not.toHaveBeenCalled();
	});

	it('uses the rule that matches, by prefix, and leaves other paths alone', async () => {
		await run('/category/keycaps').response;
		expect(cache.put.mock.calls[0][1].headers.get('Cache-Control')).toBe('public, max-age=120');
		const other = run('/basket');
		await other.response;
		expect(cache.match).toHaveBeenCalledTimes(1);
		expect(other.resolve).toHaveBeenCalledOnce();
	});

	it('never caches a request with cookies, a non-GET, or a response that sets a cookie', async () => {
		await run('/', { cookie: 'session=abc' }).response;
		await run('/', { method: 'POST' }).response;
		const setsCookie = AppHooks.pageCache(rules)({
			event: { request: new Request('https://shop.test/'), url: new URL('https://shop.test/') },
			resolve: () =>
				Promise.resolve(
					new Response('x', { headers: { 'content-type': 'text/html', 'set-cookie': 'a=b' } })
				),
		} as unknown as HandleInput);
		await setsCookie;
		expect(cache.put).not.toHaveBeenCalled();
	});

	it('does not store errors or non-page responses', async () => {
		const json = AppHooks.pageCache(rules)({
			event: { request: new Request('https://shop.test/'), url: new URL('https://shop.test/') },
			resolve: () => Promise.resolve(Response.json({ a: 1 })),
		} as unknown as HandleInput);
		await json;
		expect(cache.put).not.toHaveBeenCalled();
	});
});
