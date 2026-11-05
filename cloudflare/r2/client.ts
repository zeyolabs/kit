import { AwsClient } from 'aws4fetch';

export type PresignedUpload = {
	/** Headers the browser MUST replay verbatim on the PUT (they're signed). */
	headers: Record<string, string>;
	/** Fully-signed PUT URL (auth in query string). */
	url: string;
};

/** Keyed by the actual env/secret binding names — the caller reads them off `EnvStore`
 *  (`string()`/`secret()`), no separate camelCase shape to keep in sync. */
export type R2Config = {
	CF_ACCOUNT_ID: string;
	R2_ACCESS_KEY_ID: string;
	R2_SECRET_ACCESS_KEY: string;
	R2_UPLOADS_BUCKET: string;
};

export interface IR2Client {
	deleteObject(key: string): Promise<void>;
	getObject(key: string): Promise<ArrayBuffer>;
	getObjectWithHeaders(
		key: string
	): Promise<null | { body: ArrayBuffer; contentEncoding: null | string }>;
	presignDownload(key: string, fileName?: string, expiresSeconds?: number): Promise<string>;
	presignUpload(data: {
		contentType?: string;
		key: string;
		size: number;
	}): Promise<PresignedUpload>;
	putObject(key: string, body: BodyInit, contentType?: string): Promise<void>;
}

/**
 * Presigned direct-to-R2 access over the S3 API. Large CSVs go browser → R2 (and back) without
 * streaming through the worker. No ambient context, no app-specific knowledge — the credentials
 * are passed in.
 */
export class R2Client implements IR2Client {
	private awsClient: AwsClient | null = null;

	/** `AwsClient` construction memoized on first access — every call after the first reuses it. */
	private get client(): { base: string; client: AwsClient } {
		this.awsClient ??= new AwsClient({
			accessKeyId: this.config.R2_ACCESS_KEY_ID,
			region: 'auto',
			secretAccessKey: this.config.R2_SECRET_ACCESS_KEY,
			service: 's3',
		});
		return {
			base: `https://${this.config.CF_ACCOUNT_ID}.r2.cloudflarestorage.com/${this.config.R2_UPLOADS_BUCKET}`,
			client: this.awsClient,
		};
	}

	constructor(private readonly config: R2Config) {}

	/** Delete an object outright (authenticated S3 DELETE) — e.g. a user removing a stored export
	 *  before its R2 lifecycle rule would otherwise expire it. */
	async deleteObject(key: string): Promise<void> {
		const { base, client } = this.client;
		const res = await client.fetch(`${base}/${key}`, { method: 'DELETE' });
		if (!res.ok && res.status !== 404) throw new Error(`R2 delete ${key} failed (${res.status})`);
	}

	/**
	 * Read an object's full bytes straight from R2 (authenticated S3 GET, not presigned) — e.g.
	 * pulling a stored attachment back out at send time to embed as base64 in an outgoing email.
	 */
	async getObject(key: string): Promise<ArrayBuffer> {
		const { base, client } = this.client;
		const res = await client.fetch(`${base}/${key}`);
		if (!res.ok) throw new Error(`R2 get ${key} failed (${res.status})`);
		return res.arrayBuffer();
	}

	/**
	 * Read an object's bytes plus its `Content-Encoding`, treating a 404 as "not there" rather
	 * than throwing — e.g. reading a stored raw email that may predate whatever compression a
	 * caller now requires. Any other non-2xx still throws (an unexpected failure, not a missing
	 * object).
	 */
	async getObjectWithHeaders(
		key: string
	): Promise<null | { body: ArrayBuffer; contentEncoding: null | string }> {
		const { base, client } = this.client;
		const res = await client.fetch(`${base}/${key}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`R2 get ${key} failed (${res.status})`);
		return { body: await res.arrayBuffer(), contentEncoding: res.headers.get('content-encoding') };
	}

	/**
	 * Presign a one-shot GET for an export object so the browser downloads it straight from R2. The
	 * object lives ~3 days (R2 lifecycle); each link is presigned fresh with a short validity.
	 * `response-content-disposition` forces a download with a friendly filename (signed, so it can't
	 * be tampered with after signing).
	 */
	async presignDownload(key: string, fileName?: string, expiresSeconds = 3600): Promise<string> {
		const { base, client } = this.client;
		const disposition = fileName
			? `&response-content-disposition=${encodeURIComponent(`attachment; filename="${fileName}"`)}`
			: '';
		const endpoint = `${base}/${key}?X-Amz-Expires=${expiresSeconds}${disposition}`;
		const signed = await client.sign(endpoint, { aws: { signQuery: true }, method: 'GET' });
		return signed.url;
	}

	/**
	 * Presign a one-shot PUT straight to R2 so a large file goes browser → R2 directly and never
	 * streams through the worker. The object carries NO metadata — the mapping/listId/userId live in
	 * the `jobs.list_upload` row (keyed by this object key). Content-Length pins the exact body size; a
	 * PUT of any other length fails R2's signature check. `contentType` defaults to the original
	 * CSV-only caller's assumption so existing call sites are unaffected.
	 */
	async presignUpload(data: {
		contentType?: string;
		key: string;
		size: number;
	}): Promise<PresignedUpload> {
		const { base, client } = this.client;
		// aws4fetch reads validity from the X-Amz-Expires query param — 300s.
		const endpoint = `${base}/${data.key}?X-Amz-Expires=300`;
		const signHeaders: Record<string, string> = {
			'content-length': String(data.size),
			'content-type': data.contentType ?? 'text/csv',
		};
		const signed = await client.sign(endpoint, {
			aws: { signQuery: true },
			headers: signHeaders,
			method: 'PUT',
		});
		// The browser sets Content-Length automatically from the body (forbidden to set manually) —
		// return only the headers the client must replay verbatim.
		const { 'content-length': _contentLength, ...replay } = signHeaders;
		return { headers: replay, url: signed.url };
	}

	/**
	 * Write an object straight to R2 (authenticated S3 PUT, not presigned) — a small trigger file
	 * (drops into a notification-watched folder so the existing R2 → queue → processor pipeline
	 * picks it up, since the app has no queue producer binding) or a reply's own file attachment,
	 * whose bytes now arrive in the same request as the send rather than a presigned browser PUT.
	 */
	async putObject(key: string, body: BodyInit, contentType = 'application/json'): Promise<void> {
		const { base, client } = this.client;
		const res = await client.fetch(`${base}/${key}`, {
			body,
			headers: { 'content-type': contentType },
			method: 'PUT',
		});
		if (!res.ok) throw new Error(`R2 put ${key} failed (${res.status})`);
	}
}
