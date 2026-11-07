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
 * Starts as a warning so existing code can migrate; pass `severity: 'error'` once it is clean.
 * Override any glob in `globs` for an app with a different layout.
 * @param {{ severity?: 'error' | 'warn', globs?: { client?: string[], edge?: string[], library?: string[], manager?: string[], service?: string[] } }} [options]
 */
export function layerBoundaryRules(options = {}) {
	const severity = options.severity ?? 'warn';
	const globs = {
		client: ['**/client.server.ts', '**/clients/**/*.ts'],
		edge: ['**/*.remote.ts', '**/+server.ts', '**/+page.server.ts', '**/hooks.server.ts'],
		library: ['**/utils/**/*.ts'],
		manager: ['**/manager.server.ts'],
		service: ['**/service.server.ts'],
		...options.globs,
	};
	const importing = (group, message) => ({
		group,
		message,
	});
	const imports = {
		client: ['**/client.server', '**/client.server.ts', '**/clients/**'],
		manager: ['**/manager.server', '**/manager.server.ts'],
		service: ['**/service.server', '**/service.server.ts'],
	};
	const rule = (files, patterns) => ({
		files,
		rules: { 'no-restricted-imports': [severity, { patterns }] },
	});
	return [
		rule(globs.edge, [
			importing(imports.service, 'Edges call managers, not services (layer boundary).'),
		]),
		rule(globs.service, [
			importing(imports.manager, 'Services must not import managers (layer boundary).'),
		]),
		rule(globs.client, [
			importing(imports.manager, 'Clients must not import managers (layer boundary).'),
			importing(imports.service, 'Clients must not import services (layer boundary).'),
		]),
		rule(globs.library, [
			importing(imports.manager, 'Libraries must not import managers (layer boundary).'),
			importing(imports.service, 'Libraries must not import services (layer boundary).'),
			importing(imports.client, 'Libraries must not import clients (layer boundary).'),
		]),
	];
}
