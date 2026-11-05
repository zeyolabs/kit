import type { Gate, IGatesClient } from './client';

export class GatesDevClient implements IGatesClient {
	private readonly store = new Map<string, Gate>();

	async delete(namespace: string, key: string): Promise<void> {
		this.store.delete(`${namespace}/${key}`);
		console.log(`[gates:dev] delete ${namespace}/${key}`);
	}

	async get(namespace: string, key: string): Promise<Gate | null> {
		return this.store.get(`${namespace}/${key}`) ?? null;
	}

	async getFlag(identifier: string, fallback: boolean): Promise<boolean> {
		return this.store.get(identifier)?.value ?? fallback;
	}

	async list(namespace: string): Promise<Gate[]> {
		return [...this.store.values()].filter((g) => g.namespace === namespace);
	}

	async set(namespace: string, key: string, value: boolean): Promise<Gate> {
		const gate: Gate = { key, namespace, value };
		this.store.set(`${namespace}/${key}`, gate);
		console.log(`[gates:dev] set ${namespace}/${key} = ${value}`);
		return gate;
	}
}
