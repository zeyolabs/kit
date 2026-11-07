import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { layerBoundaryRules } from './eslint-config.js';

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
