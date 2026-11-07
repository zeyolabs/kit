import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, matchesGlob, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The package ships as source, listed in `files`. A relative import of a file that is not shipped
// works in the repo but fails in every consumer (shopping 2026.11.10 shipped without stock.ts).
// This test follows every relative import of every shipped file and checks the target is shipped.

const root = __dirname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
const included = pkg.files.filter((f) => !f.startsWith('!'));
const excluded = pkg.files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));

const rel = (file: string) => relative(root, file).replaceAll('\\', '/');

const isShipped = (file: string) => {
	const path = rel(file);
	const listed = included.some((entry) => path === entry || path.startsWith(`${entry}/`));
	return listed && !excluded.some((pattern) => matchesGlob(path, pattern));
};

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		if (name === 'node_modules') return [];
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

const shippedSource = included
	.flatMap((entry) => {
		const full = join(root, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	})
	.filter((f) => /\.(ts|js|svelte)$/.test(f) && isShipped(f));

function resolveImport(from: string, specifier: string): string | undefined {
	const base = resolve(dirname(from), specifier);
	return [base, `${base}.ts`, `${base}.js`, `${base}.svelte`, join(base, 'index.ts')].find(
		(candidate) => existsSync(candidate) && statSync(candidate).isFile()
	);
}

describe('package files', () => {
	it('ships every file that a shipped file imports by a relative path', () => {
		const missing: string[] = [];
		for (const file of shippedSource) {
			const source = readFileSync(file, 'utf8');
			for (const match of source.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
				const target = resolveImport(file, match[1]);
				if (target && !isShipped(target)) {
					missing.push(`${rel(file)} imports ${rel(target)}, which is not shipped`);
				}
			}
		}
		expect(missing).toEqual([]);
	});
});
