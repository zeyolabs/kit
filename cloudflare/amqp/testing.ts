import type { IAmqpClient } from './client';

export class FakeAmqpClient implements IAmqpClient {
	readonly published: { body: unknown; queue: string }[] = [];

	async publishJson(queue: string, body: unknown): Promise<void> {
		this.published.push({ body, queue });
	}
}
