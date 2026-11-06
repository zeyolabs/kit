#!/usr/bin/env node
// Date versioning: YYYY.MMDD.N, where MMDD is the release day in London as month × 100 + day
// (semver forbids leading zeros, so 5 January is 105 and 6 November is 1106) and N counts that
// day's releases from 0. So 2026.1106.0, then 2026.1106.1 the same day, then 2026.1107.0.
// Sets package.json, commits `release: vX` and tags it. Pushing the tag publishes (publish.yaml).
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
const day = `${Number(parts.year)}.${Number(parts.month) * 100 + Number(parts.day)}`;

if (git('status', '--porcelain')) {
	console.error('Working tree is not clean: commit or stash first.');
	process.exit(1);
}

// Today's earlier releases, including ones only on the remote.
git('fetch', '--tags', '--quiet');
const today = git('tag', '--list', `v${day}.*`)
	.split('\n')
	.filter(Boolean)
	.map((tag) => Number(tag.slice(`v${day}.`.length)));
const version = `${day}.${today.length ? Math.max(...today) + 1 : 0}`;
const tag = `v${version}`;

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
pkg.version = version;
writeFileSync('package.json', `${JSON.stringify(pkg, null, '\t')}\n`);

git('add', 'package.json');
git('commit', '-m', `release: ${tag}`);
git('tag', tag);
console.log(`Tagged ${tag}. Publish with:\n  git push origin HEAD ${tag}`);
