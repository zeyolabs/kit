import type { IR2Client, PresignedUpload } from './client';

export class FakeR2Client implements IR2Client {
	private readonly objects = new Map<
		string,
		{ body: ArrayBuffer; contentEncoding: null | string }
	>();

	async deleteObject(key: string): Promise<void> {
		this.objects.delete(key);
	}

	async getObject(key: string): Promise<ArrayBuffer> {
		const obj = this.objects.get(key);
		if (!obj) throw new Error(`R2 get ${key} failed (404)`);
		return obj.body;
	}

	async getObjectWithHeaders(
		key: string
	): Promise<null | { body: ArrayBuffer; contentEncoding: null | string }> {
		return this.objects.get(key) ?? null;
	}

	async presignDownload(key: string): Promise<string> {
		return `https://fake-r2.test/${key}`;
	}

	async presignUpload(data: { key: string }): Promise<PresignedUpload> {
		return { headers: {}, url: `https://fake-r2.test/${data.key}` };
	}

	async putObject(key: string, body: BodyInit, contentType = 'application/json'): Promise<void> {
		const arrayBuffer =
			body instanceof ArrayBuffer ? body : await new Response(body as BodyInit).arrayBuffer();
		this.objects.set(key, { body: arrayBuffer, contentEncoding: null });
		void contentType;
	}

	seed(key: string, body: ArrayBuffer, contentEncoding: null | string = null): void {
		this.objects.set(key, { body, contentEncoding });
	}
}
