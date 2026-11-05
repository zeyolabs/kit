import type { ClickHouseSettings } from './schema';

import { ClickHouseClientCore } from './client';

export type ClickHouseDevClientConfig = {
	keepAlive?: boolean;
	password: string;
	requestTimeoutMs?: number;
	settings?: ClickHouseSettings;
	url: string;
	user: string;
};

export class ClickHouseDevClient extends ClickHouseClientCore {
	constructor({ url, ...config }: ClickHouseDevClientConfig) {
		super(url, undefined, config);
	}
}
