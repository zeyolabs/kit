import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import drizzlePlugin from 'eslint-plugin-drizzle';
import perfectionist from 'eslint-plugin-perfectionist';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as svelteParser from 'svelte-eslint-parser';
import ts from 'typescript-eslint';

// Re-export `config()` so each package's eslint.config.js can import everything from this one
// package — no direct dependency on typescript-eslint required downstream.
export { ts };
export const config = ts.config;

// The consumer's .gitignore: the nearest one upward from where ESLint runs, so a monorepo app
// inherits the repo root's ignores and this package works the same installed from a registry.
function nearestGitignore(dir = process.cwd()) {
	for (let current = dir; ; current = dirname(current)) {
		const candidate = join(current, '.gitignore');
		if (existsSync(candidate)) return candidate;
		if (dirname(current) === current) return null;
	}
}

/**
 * Shared base: js + ts + prettier + perfectionist, browser+node globals. Syntactic rules only
 * (`ts.configs.recommended`), so no `projectService` is configured — type-aware linting is slow
 * and none of the enabled rules need it.
 */
export function base() {
	const gitignore = nearestGitignore();
	return [
		...(gitignore ? [includeIgnoreFile(gitignore)] : []),
		{ ignores: ['**/worker-configuration.d.ts'] },
		js.configs.recommended,
		...ts.configs.recommended,
		prettier,
		perfectionist.configs['recommended-natural'],
		{
			languageOptions: {
				globals: { ...globals.browser, ...globals.node },
			},
			rules: {
				'@typescript-eslint/consistent-type-imports': 'error',
				'@typescript-eslint/no-import-type-side-effects': 'error',
				'@typescript-eslint/no-unused-vars': [
					'error',
					{ argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' },
				],
				'perfectionist/sort-modules': ['error', { partitionByNewLine: true }],
				// ClickHouse Native decode is positional: a row schema's field order must match its
				// SELECT list, not get alphabetized. Exempt schemas passed straight to rawSelect() and
				// ones assigned to a `*CHRow` const (the established naming convention for these).
				'perfectionist/sort-objects': [
					'error',
					{
						type: 'unsorted',
						useConfigurationIf: {
							callingFunctionNamePattern: { pattern: 'rawSelect', scope: 'deep' },
						},
					},
					{
						type: 'unsorted',
						useConfigurationIf: {
							declarationMatchesPattern: { pattern: 'CHRow$', scope: 'deep' },
						},
					},
					{ partitionByNewLine: true },
				],
				'perfectionist/sort-switch-case': 'off',
			},
		},
	];
}

/**
 * Svelte parsing + recommended rules. `svelteConfig` is optional: apps pass their own
 * svelte.config.js; source packages (ui) have none and call with no argument.
 * @param {object} [svelteConfig]
 */
export function svelteRules(svelteConfig) {
	return [
		...svelte.configs.recommended,
		...svelte.configs.prettier,
		{
			files: ['**/*.svelte', '**/*.svelte.ts'],
			languageOptions: {
				parser: svelteParser,
				parserOptions: {
					extraFileExtensions: ['.svelte'],
					parser: ts.parser,
					...(svelteConfig ? { svelteConfig } : {}),
				},
			},
			rules: {
				'svelte/sort-attributes': 'error',
			},
		},
	];
}

// Drizzle safety rules: guard unfiltered delete/update. Scoped to the real drizzle handles
// (`db`, `tx`) so Map/Set `.delete()` calls aren't flagged.
const drizzleObjectName = ['db', 'tx'];
export const drizzleRules = {
	files: ['**/*.ts'],
	plugins: { drizzle: drizzlePlugin },
	rules: {
		'drizzle/enforce-delete-with-where': ['error', { drizzleObjectName }],
		'drizzle/enforce-update-with-where': ['error', { drizzleObjectName }],
	},
};

/**
 * Layer boundaries (see `standards/codex`): edges (remote functions, endpoints, hooks) reach the db
 * only through managers; services never import managers; clients and libraries import nothing
 * above them. Files are matched by name, so features keep `manager.server.ts`,
 * `service.server.ts` and `client.server.ts` (or a `clients/` folder) and libraries live in `utils/`.
 *
 * - Starts as a warning so existing code can migrate; pass `severity: 'error'` once it is clean.
 * - A file belongs to the first group it matches, in the order edge, service, client, library, so
 *   `utils/clients/x.ts` is a client and gets only the client rules.
 * - Flat config does not merge `no-restricted-imports` across entries. Put these rules LAST, and
 *   pass your own restricted-import patterns as `extraPatterns` (added to every group).
 * - Matching is by import specifier, so a barrel re-export bypasses it. An app with another layout
 *   (e.g. `services/*.ts`) passes its own `globs` (which files are which layer) and `imports`
 *   (which specifiers each layer is imported by). A green lint is not proof the boundaries hold.
 * @param {{
 *   severity?: 'error' | 'warn',
 *   globs?: { client?: string[], edge?: string[], library?: string[], service?: string[] },
 *   imports?: { client?: string[], manager?: string[], service?: string[] },
 *   extraPatterns?: { group: string[], message?: string }[],
 * }} [options]
 */
export function layerBoundaryRules(options = {}) {
	const severity = options.severity ?? 'warn';
	const extra = options.extraPatterns ?? [];
	const globs = {
		client: ['**/client.server.ts', '**/clients/**/*.ts'],
		edge: ['**/*.remote.ts', '**/+server.ts', '**/+page.server.ts', '**/hooks.server.ts'],
		library: ['**/utils/**/*.ts'],
		service: ['**/service.server.ts'],
		...options.globs,
	};
	const imports = {
		client: ['**/client.server', '**/client.server.ts', '**/clients/**'],
		manager: ['**/manager.server', '**/manager.server.ts'],
		service: ['**/service.server', '**/service.server.ts'],
		...options.imports,
	};
	const forbid = (group, message) => ({ group, message });
	// First match wins: each group ignores the files of the groups before it.
	const groups = [
		[globs.edge, [forbid(imports.service, 'Edges call managers, not services (layer boundary).')]],
		[
			globs.service,
			[forbid(imports.manager, 'Services must not import managers (layer boundary).')],
		],
		[
			globs.client,
			[
				forbid(imports.manager, 'Clients must not import managers (layer boundary).'),
				forbid(imports.service, 'Clients must not import services (layer boundary).'),
			],
		],
		[
			globs.library,
			[
				forbid(imports.manager, 'Libraries must not import managers (layer boundary).'),
				forbid(imports.service, 'Libraries must not import services (layer boundary).'),
				forbid(imports.client, 'Libraries must not import clients (layer boundary).'),
			],
		],
	];
	return groups.map(([files, patterns], index) => ({
		files,
		ignores: groups.slice(0, index).flatMap(([earlier]) => earlier),
		rules: { 'no-restricted-imports': [severity, { patterns: [...patterns, ...extra] }] },
	}));
}
