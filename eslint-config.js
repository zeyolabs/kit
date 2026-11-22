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
 * Icons come from `@lucide/svelte`, never a hand-written `<svg>`. A real drawing (a chart, a
 * progress ring) disables the line with a reason. Exported for configs that set their own
 * `svelte/no-restricted-html-elements` (flat config replaces it, not merges).
 */
export const noHandWrittenSvg = {
	elements: ['svg'],
	message:
		'Use an icon from @lucide/svelte instead of a hand-written <svg>. A chart or drawing: disable this line with a reason.',
};

const UI_TEXT = {
	h1: 'Title level={1}',
	h2: 'Title level={2}',
	h3: 'Title level={3}',
	h4: 'Title level={4}',
	h5: 'Title level={5}',
	h6: 'Title level={6}',
	p: 'Text',
	span: 'Span',
};

// Class strings that set text size, weight, tracking or line height, or hand-build a flex stack or
// row: the ui text components and Stack/Cluster own those, so the scale stays in one place.
const TYPOGRAPHY_CLASS =
	'(^|\\s)([a-z0-9]+:)*(text-(xs|sm|base|lg|xl|[2-9]xl)|text-\\[[0-9]|font-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|tracking-|leading-)';
const STACK_CLASS = '^(?=.*(^|\\s)flex(\\s|$))(?=.*(^|\\s)flex-col(\\s|$))(?=.*(^|\\s)gap-)';
const ROW_CLASS = '^(?!.*(^|\\s)flex-col(\\s|$))(?=.*(^|\\s)flex(\\s|$))(?=.*(^|\\s)gap-)';

/** `no-restricted-syntax` entries that match a pattern in any static class string. */
function classRules(pattern, message) {
	return ['SvelteLiteral', 'Literal'].map((node) => ({
		message,
		selector: `SvelteAttribute[key.name='class'] ${node}[value=/${pattern}/]`,
	}));
}

// A `<style>` rule made only of layout that a ui component expresses exactly: a flex column
// (Stack), a centred flex row (Cluster), or equal / auto-fit columns (Grid). Rules that also set
// padding, borders, sizes etc. style the element and are left alone, and so are links, buttons,
// lists, labels and forms, which a layout component would strip of their element.
const LAYOUT_PROPERTIES = new Set([
	'align-items',
	'column-gap',
	'display',
	'flex-direction',
	'flex-wrap',
	'gap',
	'grid-template-columns',
	'justify-content',
	'row-gap',
]);
const KEEP_ELEMENTS = new Set(['a', 'button', 'form', 'label', 'li', 'ol', 'summary', 'ul']);

/** Which component a pure-layout declaration block maps to, or null. */
function layoutComponent(body) {
	const decls = new Map();
	for (const part of body.split(';')) {
		const i = part.indexOf(':');
		if (i > 0) decls.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
	}
	if ([...decls.keys()].some((k) => !LAYOUT_PROPERTIES.has(k))) return null;
	const display = decls.get('display');
	const align = decls.get('align-items');
	if (display === 'flex' && decls.get('flex-direction') === 'column') {
		return align === 'baseline' ? null : 'Stack';
	}
	if (display === 'flex' && !decls.has('flex-direction')) {
		return !align || align === 'center' ? 'Cluster' : null;
	}
	const columns = decls.get('grid-template-columns');
	if (display === 'grid' && columns && /^repeat\(\s*(\d+|auto-fit|auto-fill)\s*,/.test(columns)) {
		return 'Grid';
	}
	return null;
}

/** `zeyolabs/layout-css`: flags hand-written CSS layout on plain elements. */
const layoutCssRule = {
	create(context) {
		const byClass = new Map();
		const styles = [...context.sourceCode.text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(
			(m) => m[1]
		);
		for (const style of styles) {
			for (const [, selector, body] of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
				const component = layoutComponent(body);
				if (!component) continue;
				for (const sel of selector.split(',').map((s) => s.trim())) {
					const m = /^\.([\w-]+)$/.exec(sel);
					if (m) byClass.set(m[1], component);
				}
			}
		}
		if (byClass.size === 0) return {};
		return {
			SvelteElement(node) {
				if (node.kind !== 'html' || KEEP_ELEMENTS.has(node.name.name)) return;
				const cls = node.startTag.attributes.find(
					(a) => a.type === 'SvelteAttribute' && a.key.name === 'class'
				);
				const text = cls?.value?.map((v) => (v.type === 'SvelteLiteral' ? v.value : '')).join(' ');
				const hit = text?.split(/\s+/).find((c) => byClass.has(c));
				if (!hit) return;
				const component = byClass.get(hit);
				context.report({
					message: `.${hit} is only layout: use <${component}> from @zeyolabs/ui/layout instead of CSS.`,
					node: node.startTag,
				});
			},
		};
	},
	meta: { schema: [], type: 'suggestion' },
};

const UI_CLASS_RULES = [
	...classRules(
		TYPOGRAPHY_CLASS,
		'Set text size, weight and spacing with the Title/Text/Span props from @zeyolabs/ui/text, not classes.'
	),
	...classRules(
		STACK_CLASS,
		'Use <Stack> from @zeyolabs/ui/layout for a vertical flex with a gap.'
	),
	...classRules(ROW_CLASS, 'Use <Cluster> from @zeyolabs/ui/layout for a flex row with a gap.'),
];

/**
 * Svelte parser and rules. Apps pass their svelte config; source packages (ui) call it without one.
 * `uiText: true` (apps on @zeyolabs/ui) also bans raw `h1`-`h6`, `p` and `span`, so text goes
 * through `Title`/`Text`/`Span` and stays on one type scale, and bans classes that set text size,
 * weight, tracking or line height or hand-build a flex stack or row (`Stack`/`Cluster` instead).
 * @param {object} [svelteConfig]
 * @param {{ uiText?: boolean }} [options]
 */
export function svelteRules(svelteConfig, { uiText = false } = {}) {
	const restricted = [
		noHandWrittenSvg,
		...(uiText
			? Object.entries(UI_TEXT).map(([element, use]) => ({
					elements: [element],
					message: `Use <${use}> from @zeyolabs/ui/text instead of <${element}>.`,
				}))
			: []),
	];
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
			plugins: { zeyolabs: { rules: { 'layout-css': layoutCssRule } } },
			rules: {
				'svelte/no-restricted-html-elements': ['error', ...restricted],
				'svelte/sort-attributes': 'error',
				...(uiText
					? {
							'no-restricted-syntax': ['error', ...UI_CLASS_RULES],
							'zeyolabs/layout-css': 'error',
						}
					: {}),
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
