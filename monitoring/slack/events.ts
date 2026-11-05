// Slack Events API envelope shapes — generic wire format, no app domain knowledge.
export type SlackMessageEvent = {
	bot_id?: string;
	channel: string;
	subtype?: string;
	text: string;
	thread_ts?: string;
	ts: string;
	type: 'message';
	user?: string;
};

export type SlackPayload =
	| { challenge: string; type: 'url_verification' }
	| { event: SlackMessageEvent; event_id: string; type: 'event_callback' };
