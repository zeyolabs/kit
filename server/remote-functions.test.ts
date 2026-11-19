import { error, redirect } from '@sveltejs/kit';
import { z } from 'zod';

import { Error404 } from '../utils/errors';
import { Fail } from './result';

vi.mock('$app/server', () => ({
	command: (...args: unknown[]) => args.at(-1),
	form: (_schema: unknown, run: unknown) => run,
	query: (...args: unknown[]) => args.at(-1),
}));
vi.mock('./logger', () => ({ logger: { error: vi.fn() } }));

const { Remote } = await import('./remote-functions');

type Run = (input?: unknown) => Promise<unknown>;
const schema = z.object({});
const form = (run: () => Promise<unknown>) => Remote.Form(schema, run) as unknown as Run;
const query = (run: () => Promise<unknown>) => Remote.Query(run) as unknown as Run;

describe('Remote.Form', () => {
	it('lets a redirect through', async () => {
		await expect(form(() => redirect(303, '/done'))({})).rejects.toMatchObject({
			location: '/done',
			status: 303,
		});
	});

	it('turns expected failures into inline errors', async () => {
		await expect(form(() => Promise.reject(Error404('Gone')))({})).resolves.toMatchObject({
			message: 'Gone',
			type: 'error',
		});
		await expect(form(() => Promise.reject(Fail('Nope')))({})).resolves.toMatchObject({
			message: 'Nope',
		});
		await expect(form(() => error(409, 'Taken'))({})).resolves.toMatchObject({
			message: 'Taken',
		});
	});

	it('hides unexpected errors', async () => {
		await expect(form(() => Promise.reject(new Error('db down')))({})).resolves.toMatchObject({
			message: 'Something went wrong. Please try again.',
		});
	});
});

describe('Remote.Query', () => {
	it('keeps the status of an expected failure', async () => {
		await expect(query(() => Promise.reject(Error404('Gone')))()).rejects.toMatchObject({
			body: { message: 'Gone' },
			status: 404,
		});
	});

	it('collapses unexpected errors to a 500', async () => {
		await expect(query(() => Promise.reject(new Error('db down')))()).rejects.toMatchObject({
			status: 500,
		});
	});
});

describe('isMalformedFormRequest', () => {
	it("matches SvelteKit's form field errors, in production and dev wording", async () => {
		const { isMalformedFormRequest } = await import('./remote-functions');
		expect(isMalformedFormRequest(new Error('https://svelte.dev/e/kit/form_field_unbound'))).toBe(
			true
		);
		expect(
			isMalformedFormRequest(
				new Error(
					'form_field_duplicate\nForm field `name` appeared 2 times\nhttps://svelte.dev/e/kit/form_field_duplicate'
				)
			)
		).toBe(true);
	});

	it('leaves every other error alone', async () => {
		const { isMalformedFormRequest } = await import('./remote-functions');
		expect(
			isMalformedFormRequest(new Error('https://svelte.dev/e/kit/invalid_redirect_status'))
		).toBe(false);
		expect(isMalformedFormRequest(new Error('db down'))).toBe(false);
		expect(isMalformedFormRequest('form_field_unbound')).toBe(false);
	});
});
