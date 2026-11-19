import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { layerBoundaryRules, svelteRules } from './eslint-config.js';

type Extra = { group: string[]; message?: string }[];

async function lint(
	filePath: string,
	code: string,
	options: { extraPatterns?: Extra; severity?: 'error' | 'warn' } = {}
) {
	const eslint = new ESLint({
		cwd: process.cwd(),
		overrideConfig: [{ files: ['**/*.ts'] }, ...layerBoundaryRules(options)],
		overrideConfigFile: true,
	});
	const [result] = await eslint.lintText(code, { filePath });
	return result?.messages.map((m) => ({ severity: m.severity, text: m.message })) ?? [];
}

const importOf = (specifier: string) => `import { a } from '${specifier}';\nvoid a;\n`;

describe('layerBoundaryRules', () => {
	it('warns when an edge imports a service', async () => {
		expect(await lint('features/tags/tags.remote.ts', importOf('./service.server'))).toEqual([
			{
				severity: 1,
				text: expect.stringContaining('Edges call managers, not services (layer boundary).'),
			},
		]);
	});

	it('lets an edge import a manager', async () => {
		expect(await lint('features/tags/tags.remote.ts', importOf('./manager.server'))).toEqual([]);
	});

	it('flags a service importing a manager, as an error when asked', async () => {
		expect(
			await lint('features/tags/service.server.ts', importOf('./manager.server'), {
				severity: 'error',
			})
		).toEqual([
			{
				severity: 2,
				text: expect.stringContaining('Services must not import managers (layer boundary).'),
			},
		]);
	});

	it('flags a client importing a manager or a service', async () => {
		expect(await lint('x/client.server.ts', importOf('./manager.server'))).toHaveLength(1);
		expect(await lint('x/client.server.ts', importOf('./service.server'))).toHaveLength(1);
	});

	it('flags a library importing a manager, service or client', async () => {
		expect(await lint('core/utils/x.ts', importOf('../a/manager.server'))).toHaveLength(1);
		expect(await lint('core/utils/x.ts', importOf('../a/service.server'))).toHaveLength(1);
		expect(await lint('core/utils/normalize.ts', importOf('../clients/porkbun'))).toHaveLength(1);
	});

	it('gives a file in two groups only the first group rules', async () => {
		// utils/clients/x.ts is both a client and a library; as a client it may import a client.
		expect(await lint('core/utils/clients/x.ts', importOf('./client.server'))).toEqual([]);
	});

	it('adds extraPatterns to every group', async () => {
		const extraPatterns = [{ group: ['lodash'], message: 'No lodash.' }];
		expect(await lint('core/utils/x.ts', importOf('lodash'), { extraPatterns })).toHaveLength(1);
		expect(
			await lint('features/tags/service.server.ts', importOf('lodash'), { extraPatterns })
		).toHaveLength(1);
	});

	it('leaves other files alone', async () => {
		expect(await lint('app/page.ts', importOf('./service.server'))).toEqual([]);
	});
});

describe('svelteRules', () => {
	async function restricted(code: string, options?: { uiText?: boolean }) {
		const eslint = new ESLint({
			cwd: process.cwd(),
			overrideConfig: svelteRules(undefined, options),
			overrideConfigFile: true,
		});
		const [result] = await eslint.lintText(code, { filePath: 'Page.svelte' });
		return (result?.messages ?? [])
			.filter((m) => m.ruleId === 'svelte/no-restricted-html-elements')
			.map((m) => m.message);
	}

	const page = '<h1>Title</h1>\n<p>Body</p>\n<svg></svg>\n';

	it('bans hand-written svg by default but not text tags', async () => {
		expect(await restricted(page)).toEqual([expect.stringContaining('@lucide/svelte')]);
	});

	async function classMessages(code: string) {
		const eslint = new ESLint({
			cwd: process.cwd(),
			overrideConfig: svelteRules(undefined, { uiText: true }),
			overrideConfigFile: true,
		});
		const [result] = await eslint.lintText(code, { filePath: 'Page.svelte' });
		return (result?.messages ?? [])
			.filter((m) => m.ruleId === 'no-restricted-syntax')
			.map((m) => `${m.line}: ${m.message.split(' ').slice(0, 2).join(' ')}`);
	}

	it('bans hand-set text size, weight, tracking and line height with uiText', async () => {
		const code = [
			'<a class="text-sm font-semibold">a</a>',
			"<div class={wide ? 'md:text-lg' : ''}>b</div>",
			'<div class="leading-tight">c</div>',
			'<div class="mt-4 text-white">d</div>',
		].join('\n');
		expect(await classMessages(code)).toEqual(['1: Set text', '2: Set text', '3: Set text']);
	});

	it('bans hand-built flex stacks and rows with uiText, not grids', async () => {
		const code = [
			'<div class="flex flex-col gap-2">a</div>',
			'<div class="flex items-center gap-1.5">b</div>',
			'<div class="grid gap-4">c</div>',
			'<div class="flex-col">d</div>',
		].join('\n');
		expect(await classMessages(code)).toEqual(['1: Use <Stack>', '2: Use <Cluster>']);
	});

	it('bans raw text tags with uiText', async () => {
		expect(await restricted(page, { uiText: true })).toEqual([
			'Use <Title level={1}> from @zeyolabs/ui/text instead of <h1>.',
			'Use <Text> from @zeyolabs/ui/text instead of <p>.',
			expect.stringContaining('@lucide/svelte'),
		]);
	});
});
