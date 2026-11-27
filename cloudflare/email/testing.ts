import type { Email, IEmailClient } from './base';

/** Records every message instead of sending anything — for asserting what a service emailed,
 *  without a mock transport. Set `succeeds = false` to simulate a delivery failure. */
export class FakeEmailClient implements IEmailClient {
	readonly sent: Email[] = [];
	succeeds = true;

	async deliver(input: Email): Promise<void> {
		this.sent.push(input);
		if (!this.succeeds) throw new Error('delivery failed');
	}

	async send(input: Email): Promise<boolean> {
		this.sent.push(input);
		return this.succeeds;
	}
}
