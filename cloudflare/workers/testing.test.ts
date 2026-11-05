import { beforeEach, describe, expect, it } from 'vitest';

import { mockDurableObjectStorage } from './testing';

describe('mockDurableObjectStorage', () => {
	const storage = mockDurableObjectStorage();
	beforeEach(() => storage.reset());

	it('returns undefined for a missing key', async () => {
		await expect(storage.get('missing')).resolves.toBeUndefined();
	});

	it('round-trips a single key', async () => {
		await storage.put('a', { n: 1 });
		await expect(storage.get<{ n: number }>('a')).resolves.toEqual({ n: 1 });
	});

	it('put(entries) sets multiple keys at once', async () => {
		await storage.put({ a: 1, b: 2 });
		await expect(storage.get<number>(['a', 'b', 'missing'])).resolves.toEqual(
			new Map([
				['a', 1],
				['b', 2],
			])
		);
	});

	it('list() returns all keys sorted lexicographically', async () => {
		await storage.put('b', 2);
		await storage.put('a', 1);
		await storage.put('c', 3);
		await expect(storage.list<number>()).resolves.toEqual(
			new Map([
				['a', 1],
				['b', 2],
				['c', 3],
			])
		);
	});

	it('list({prefix}) filters to matching keys only', async () => {
		await storage.put('slot:1', 'x');
		await storage.put('slot:2', 'y');
		await storage.put('other:1', 'z');
		await expect(storage.list({ prefix: 'slot:' })).resolves.toEqual(
			new Map([
				['slot:1', 'x'],
				['slot:2', 'y'],
			])
		);
	});

	it('list({reverse: true}) reverses order', async () => {
		await storage.put('a', 1);
		await storage.put('b', 2);
		const result = await storage.list<number>({ reverse: true });
		expect([...result.keys()]).toEqual(['b', 'a']);
	});

	it('list({limit}) caps the result count', async () => {
		await storage.put('a', 1);
		await storage.put('b', 2);
		await storage.put('c', 3);
		await expect(storage.list<number>({ limit: 2 })).resolves.toEqual(
			new Map([
				['a', 1],
				['b', 2],
			])
		);
	});

	it('reset() clears all rows', async () => {
		await storage.put('a', 1);
		storage.reset();
		await expect(storage.get('a')).resolves.toBeUndefined();
	});

	it('throws for an unimplemented method instead of silently no-opping', () => {
		expect(() => storage.deleteAll()).toThrow(/not implemented/);
	});

	it('getAlarm() returns null until one is set', async () => {
		await expect(storage.getAlarm()).resolves.toBeNull();
	});

	it('setAlarm()/getAlarm() round-trip a timestamp, in both Date and number form', async () => {
		await storage.setAlarm(1000);
		await expect(storage.getAlarm()).resolves.toBe(1000);
		await storage.setAlarm(new Date(2000));
		await expect(storage.getAlarm()).resolves.toBe(2000);
	});

	it('deleteAlarm() clears it', async () => {
		await storage.setAlarm(1000);
		await storage.deleteAlarm();
		await expect(storage.getAlarm()).resolves.toBeNull();
	});

	it('reset() also clears the alarm', async () => {
		await storage.setAlarm(1000);
		storage.reset();
		await expect(storage.getAlarm()).resolves.toBeNull();
	});
});
