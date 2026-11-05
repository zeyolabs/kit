#!/usr/bin/env node
// Date versioning: the version is the release day in London, YYYY.M.D (semver forbids leading
// zeros, so 2026.11.5 not 2026.11.05). One release per package per day.
// Sets package.json, commits `release: vYYYY.M.D` and tags it. Pushing the tag publishes (publish.yaml).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const parts = Object.fromEntries(
	new Intl.DateTimeFormat('en-GB', {
		day: 'numeric',
		month: 'numeric',
		timeZone: 'Europe/London',
		year: 'numeric',
	})
		.formatToParts(new Date())
		.map(({ type, value }) => [type, value])
);
const version = `${Number(parts.year)}.${Number(parts.month)}.${Number(parts.day)}`;
const tag = `v${version}`;

if (git('status', '--porcelain')) {
	console.error('Working tree is not clean: commit or stash first.');
	process.exit(1);
}
if (git('tag', '--list', tag)) {
	console.error(
		`${tag} already exists: one release per day. Release tomorrow, or ship it in that one.`
	);
	process.exit(1);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = version;
writeFileSync('package.json', `${JSON.stringify(pkg, null, '\t')}\n`);

git('add', 'package.json');
git('commit', '-m', `release: ${tag}`);
git('tag', tag);
console.log(`Tagged ${tag}. Publish with:\n  git push origin HEAD ${tag}`);
