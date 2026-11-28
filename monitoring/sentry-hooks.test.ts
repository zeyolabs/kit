import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
	handleErrorWithSentry: vi.fn((onError?: unknown) => onError ?? (() => {})),
	init: vi.fn(),
	initCloudflareSentryHandle: vi.fn(
		() =>
			async ({ event, resolve }: never) =>
				resolve(event)
	),
	sentryHandle: vi.fn(
		() =>
			async ({ event, resolve }: never) =>
				resolve(event)
	),
}));
const cloudflare = vi.hoisted(() => ({
	captureException: vi.fn(),
	instrumentDurableObjectWithSentry: vi.fn((_options: unknown, cls: unknown) => cls),
	withSentry: vi.fn((_options: unknown, handler: unknown) => handler),
}));

vi.mock('$app/env', () => ({ dev: false }));
vi.mock('$app/env/public', () => ({ SENTRY_DSN: 'https://key@sentry.test/1' }));
vi.mock('$app/state', () => ({ updated: { check: async () => false, current: false } }));
vi.mock('$app/server', () => ({ command: vi.fn(), form: vi.fn(), query: vi.fn() }));
vi.mock('@sentry/sveltekit', () => sdk);
vi.mock('@sentry/cloudflare', () => cloudflare);

const { Sentry: ClientSentry } = await import('./sentry-client');
const { Sentry: ServerSentry } = await import('./sentry-server');
const { Sentry: WorkerSentry } = await import('./sentry-worker');

beforeEach(() => vi.clearAllMocks());

describe('Sentry.clientHandleError', () => {
	it('inits with the app DSN, its mode as the environment and the service tag', () => {
		ClientSentry.clientHandleError({ service: 'admin' });
		expect(sdk.init).toHaveBeenCalledWith(
			expect.objectContaining({
				dsn: 'https://key@sentry.test/1',
				enabled: true,
				environment: import.meta.env.MODE,
				initialScope: { tags: { service: 'admin' } },
			})
		);
	});

	it('reports only unexpected client errors', () => {
		const report = vi.fn();
		sdk.handleErrorWithSentry.mockReturnValueOnce(report);
		const handleError = ClientSentry.clientHandleError();
		handleError({ error: { status: 404 }, kind: 'expected' } as never);
		expect(report).not.toHaveBeenCalled();
		handleError({ error: new Error('x'), kind: 'unknown' } as never);
		expect(report).toHaveBeenCalledOnce();
	});
});

describe('Sentry.serverHandle', () => {
	it('passes the release the build plugin injected', () => {
		vi.stubGlobal('SENTRY_RELEASE', { id: 'abc123' });
		ServerSentry.serverHandle();
		expect(sdk.initCloudflareSentryHandle).toHaveBeenCalledWith(
			expect.objectContaining({ dsn: 'https://key@sentry.test/1', release: 'abc123' })
		);
		vi.unstubAllGlobals();
	});

	it('runs without an injected release', () => {
		ServerSentry.serverHandle({ service: 'web' });
		expect(sdk.initCloudflareSentryHandle).toHaveBeenCalledWith(
			expect.objectContaining({ release: undefined })
		);
	});
});

describe('Sentry.worker', () => {
	it("reads the DSN and release from the Worker's env", () => {
		const handler = { fetch: async () => new Response() };
		expect(WorkerSentry.worker({ service: 'mcp' }, handler)).toBe(handler);
		const optionsFor = cloudflare.withSentry.mock.calls[0]?.[0] as (env: object) => object;
		expect(
			optionsFor({ SENTRY_DSN: 'https://k@sentry.test/2', SENTRY_RELEASE: 'r1' })
		).toMatchObject({
			dsn: 'https://k@sentry.test/2',
			environment: 'production',
			initialScope: { tags: { service: 'mcp' } },
			release: 'r1',
		});
	});

	it('instruments a Durable Object with the same options', () => {
		class Hub {}
		expect(WorkerSentry.durableObject({ service: 'realtime' }, Hub as never)).toBe(Hub);
		const optionsFor = cloudflare.instrumentDurableObjectWithSentry.mock.calls[0]?.[0] as (
			env: object
		) => object;
		expect(optionsFor({ SENTRY_DSN: 'x' })).toMatchObject({ dsn: 'x', enabled: true });
	});
});
