import type { EmailInput, IEmailClient } from './base';

/** Records every message instead of sending anything — for asserting what a service emailed,
 *  without a mock transport. Set `succeeds = false` to simulate a delivery failure. */
export class FakeEmailClient implements IEmailClient {
	readonly sent: EmailInput[] = [];
	succeeds = true;

	async deliver(input: EmailInput): Promise<void> {
		this.sent.push(input);
		if (!this.succeeds) throw new Error('delivery failed');
	}

	async send(input: EmailInput): Promise<boolean> {
		this.sent.push(input);
		return this.succeeds;
	}
}
