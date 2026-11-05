import type { RedisClient } from './client';
import type { RespValue } from './protocol';

type StringEntry = { expiresAt?: number; value: string };

/** In-memory `RedisClient` stand-in for tests: `hSet`/`hGetAll`/`hGetAllMany`/`hDel`/`command`/
 *  `pipeline` round-trip for real, no live connection needed. The returned client also carries a
 *  `reset()` that clears all keys, so a caller doesn't have to destructure `{ client, reset }`
 *  apart -- `const redis = mockRedis(); ...; redis.reset();`.
 *
 *  `RedisClient` is a class with private fields (`connPromise`/`queue`), so no plain object can
 *  structurally satisfy it -- the `as unknown as RedisClient` cast below is required, not a
 *  shortcut. What that cast does hide is method *coverage*: every method on the cast object must
 *  actually behave like the real one, or a caller that reaches past `hSet`/`hGetAll` (e.g. the
 *  raw `command()` escape hatch `typed-rows.service.server.ts` uses for `SET ... EX`) gets a
 *  silent `undefined is not a function` instead of a compile error. `command()`/`pipeline()` are
 *  real here for exactly that reason; `eval()` throws instead of faking a Lua interpreter, since
 *  nothing in this codebase calls it yet. */
export function mockRedis(): RedisClient & { reset: () => void } {
	const hashes = new Map<string, Record<string, string>>();
	const strings = new Map<string, StringEntry>();

	const hGetAll = async (key: string): Promise<Record<string, string>> => ({
		...(hashes.get(key) ?? {}),
	});
	const hSet = async (key: string, fields: Record<string, number | string>): Promise<number> => {
		const hash = hashes.get(key) ?? {};
		let added = 0;
		for (const [field, value] of Object.entries(fields)) {
			if (!(field in hash)) added++;
			hash[field] = String(value);
		}
		hashes.set(key, hash);
		return added;
	};
	const hDel = async (key: string, ...fields: string[]): Promise<number> => {
		const hash = hashes.get(key);
		if (!hash) return 0;
		let removed = 0;
		for (const field of fields) {
			if (field in hash) {
				delete hash[field];
				removed++;
			}
		}
		return removed;
	};

	// Not a real RESP dispatcher -- just the commands this codebase actually issues via the raw
	// escape hatch (SET/GET, with SET's optional `EX <seconds>` ttl) plus HSET/HGETALL/HDEL routed
	// through the same maps the typed methods use, so mixing `command()` and `hSet()` on one fake
	// sees one consistent store. Add a case if a future caller needs one -- the default throws
	// instead of silently no-op'ing so a gap here fails loud, at the call site, immediately.
	const command = async (args: (number | string)[]): Promise<RespValue> => {
		const [cmd, ...rest] = args.map(String);
		switch (cmd.toUpperCase()) {
			case 'DEL': {
				const [key] = rest;
				const existed = strings.delete(key);
				return existed ? 1 : 0;
			}
			case 'GET': {
				const [key] = rest;
				const entry = strings.get(key);
				if (!entry) return null;
				if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
					strings.delete(key);
					return null;
				}
				return entry.value;
			}
			case 'HDEL': {
				const [key, ...fields] = rest;
				return hDel(key, ...fields);
			}
			case 'HGETALL': {
				const [key] = rest;
				return Object.entries(await hGetAll(key)).flat();
			}
			case 'HSET': {
				const [key, ...pairs] = rest;
				const fields: Record<string, string> = {};
				for (let i = 0; i < pairs.length; i += 2) fields[pairs[i]] = pairs[i + 1];
				return hSet(key, fields);
			}
			case 'SET': {
				const [key, value, ...opts] = rest;
				const exIndex = opts.findIndex((o) => o.toUpperCase() === 'EX');
				const ttlSeconds = exIndex >= 0 ? Number(opts[exIndex + 1]) : undefined;
				strings.set(key, {
					expiresAt: ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : undefined,
					value,
				});
				return 'OK';
			}
			default:
				throw new Error(`mockRedis(): unhandled command "${cmd}" -- add a case if a test needs it`);
		}
	};

	return {
		close: async () => {},
		command,
		eval: async () => {
			throw new Error('mockRedis(): eval() is not implemented -- no test needs Lua scripting yet');
		},
		hDel,
		hGetAll,
		hGetAllMany: async (keys: string[]): Promise<Record<string, string>[]> =>
			Promise.all(keys.map((key) => hGetAll(key))),
		hSet,
		pipeline: async (commandsList: (number | string)[][]): Promise<RespValue[]> => {
			const results: RespValue[] = [];
			for (const args of commandsList) results.push(await command(args));
			return results;
		},
		reset: () => {
			hashes.clear();
			strings.clear();
		},
	} as unknown as RedisClient & { reset: () => void };
}
