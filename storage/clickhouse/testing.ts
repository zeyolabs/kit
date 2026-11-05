import type { z } from 'zod';

import type { ClickHouseTable, IClickHouseClient, Select } from './client';
import type { ClickHouseSettings } from './schema';

export class FakeClickHouseClient implements IClickHouseClient {
	readonly commands: string[] = [];
	private rawSelectQueue: unknown[][] = [];
	private readonly rows = new Map<string, Record<string, unknown>[]>();

	async command(sql: string): Promise<void> {
		this.commands.push(sql);
	}

	async insert<S extends z.ZodObject>(
		table: string,
		_schema: S,
		rows: z.infer<S>[]
	): Promise<void> {
		const existing = this.rows.get(table) ?? [];
		this.rows.set(table, [...existing, ...(rows as Record<string, unknown>[])]);
	}

	async rawSelect<S extends z.ZodObject>(): Promise<z.infer<S>[]> {
		return (this.rawSelectQueue.shift() ?? []) as z.infer<S>[];
	}

	seedRawSelect(rows: unknown[]): void {
		this.rawSelectQueue.push(rows);
	}

	seedTable(table: string, rows: Record<string, unknown>[]): void {
		this.rows.set(table, rows);
	}

	select<T extends z.ZodObject, K extends keyof T['shape'] & string>(
		table: ClickHouseTable<T>,
		columns: K[]
	): Select<T, K> {
		const rows = () =>
			(this.rows.get(table.name) ?? []).map(
				(row) => Object.fromEntries(columns.map((c) => [c, row[c]])) as Pick<z.infer<T>, K>
			);
		return new FakeSelect(rows);
	}
}

class FakeSelect<T extends z.ZodObject, K extends keyof T['shape'] & string> implements Select<
	T,
	K
> {
	constructor(private readonly rows: () => Pick<z.infer<T>, K>[]) {}

	distinct(): Select<T, K> {
		return this;
	}
	limit(): Select<T, K> {
		return this;
	}
	limitBy(): Select<T, K> {
		return this;
	}
	offset(): Select<T, K> {
		return this;
	}
	orderBy(): Select<T, K> {
		return this;
	}
	settings(_settings: ClickHouseSettings): Select<T, K> {
		return this;
	}
	then<F = Pick<z.infer<T>, K>[], J = never>(
		onFulfilled?: ((value: Pick<z.infer<T>, K>[]) => F | PromiseLike<F>) | null,
		onRejected?: ((reason: unknown) => J | PromiseLike<J>) | null
	): PromiseLike<F | J> {
		return Promise.resolve(this.rows()).then(onFulfilled, onRejected);
	}
	where(): Select<T, K> {
		return this;
	}
}
