import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { layerBoundaryRules } from './eslint-config.js';

async function lint(filePath: string, code: string, severity?: 'error' | 'warn') {
	const eslint = new ESLint({
		cwd: process.cwd(),
		overrideConfig: [{ files: ['**/*.ts'] }, ...layerBoundaryRules({ severity })],
		overrideConfigFile: true,
	});
	const [result] = await eslint.lintText(code, { filePath });
	return result?.messages.map((m) => ({ severity: m.severity, text: m.message })) ?? [];
}

describe('layerBoundaryRules', () => {
	it('warns when an edge imports a service', async () => {
		const messages = await lint(
			'features/tags/tags.remote.ts',
			"import { TagService } from './service.server';\nvoid TagService;\n"
		);
		expect(messages).toEqual([
			{
				severity: 1,
				text: expect.stringContaining('Edges call managers, not services (layer boundary).'),
			},
		]);
	});

	it('lets an edge import a manager', async () => {
		expect(
			await lint(
				'features/tags/tags.remote.ts',
				"import { TagManager } from './manager.server';\nvoid TagManager;\n"
			)
		).toEqual([]);
	});

	it('flags a service importing a manager, as an error when asked', async () => {
		const messages = await lint(
			'features/tags/service.server.ts',
			"import { TagManager } from './manager.server';\nvoid TagManager;\n",
			'error'
		);
		expect(messages).toEqual([
			{
				severity: 2,
				text: expect.stringContaining('Services must not import managers (layer boundary).'),
			},
		]);
	});

	it('flags a library importing a client', async () => {
		const messages = await lint(
			'core/utils/normalize.ts',
			"import { PorkbunClient } from '../clients/porkbun';\nvoid PorkbunClient;\n"
		);
		expect(messages).toHaveLength(1);
	});

	it('leaves other files alone', async () => {
		expect(await lint('app/page.ts', "import { x } from './service.server';\nvoid x;\n")).toEqual(
			[]
		);
	});
});
