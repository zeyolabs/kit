import type { EmailInput, IEmailClient } from './client';

/** Records every message passed to `send` instead of sending anything — for asserting what a
 *  service emailed, without a mock binding. Set `succeeds = false` to simulate a delivery failure. */
export class FakeEmailClient implements IEmailClient {
	readonly sent: EmailInput[] = [];
	succeeds = true;

	async send(input: EmailInput): Promise<boolean> {
		this.sent.push(input);
		return this.succeeds;
	}
}
