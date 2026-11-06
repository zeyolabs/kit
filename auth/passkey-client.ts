// Browser side of the passkey endpoints in `routes.ts`. Uses the WebAuthn JSON helpers
// (`PublicKeyCredential.parse*OptionsFromJSON`, `credential.toJSON()`), available in every
// current browser. Import only from client code (event handlers), never at module scope on the
// server.

type JsonCredential = { toJSON(): unknown };

type PublicKeyCredentialStatic = {
	isConditionalMediationAvailable?: () => Promise<boolean>;
	parseCreationOptionsFromJSON(options: unknown): unknown;
	parseRequestOptionsFromJSON(options: unknown): unknown;
};

type CredentialsContainer = {
	create(options: { publicKey: unknown }): Promise<JsonCredential | null>;
	get(options: {
		mediation?: 'conditional' | 'optional';
		publicKey: unknown;
		signal?: AbortSignal;
	}): Promise<JsonCredential | null>;
};

/** Whether this browser can use passkeys at all (and has the JSON helpers we rely on). */
export function passkeysSupported(): boolean {
	const pkc = (globalThis as { PublicKeyCredential?: PublicKeyCredentialStatic })
		.PublicKeyCredential;
	return typeof pkc?.parseRequestOptionsFromJSON === 'function';
}

/** Whether the browser can offer passkeys from the email field's autofill. */
export async function conditionalPasskeysSupported(): Promise<boolean> {
	if (!passkeysSupported()) return false;
	const pkc = (globalThis as unknown as { PublicKeyCredential: PublicKeyCredentialStatic })
		.PublicKeyCredential;
	return (await pkc.isConditionalMediationAvailable?.()) ?? false;
}

export class PasskeyClientError extends Error {
	override name = 'PasskeyClientError';
	constructor(
		message: string,
		/** The server asked for a fresh sign-in before adding a passkey. */
		readonly reauth = false
	) {
		super(message);
	}
}

async function post(path: string, body?: unknown): Promise<Record<string, unknown>> {
	const response = await fetch(path, {
		body: JSON.stringify(body ?? {}),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});
	const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok) {
		throw new PasskeyClientError(String(data.message ?? 'Request failed'), data.reauth === true);
	}
	return data;
}

function api() {
	const g = globalThis as unknown as {
		navigator: { credentials: CredentialsContainer };
		PublicKeyCredential: PublicKeyCredentialStatic;
	};
	return { credentials: g.navigator.credentials, pkc: g.PublicKeyCredential };
}

/** True when the user dismissed the browser prompt (not worth showing an error for). */
export function isPasskeyCancel(err: unknown): boolean {
	return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

/**
 * Signs in with a passkey and returns where to go next. With `conditional`, the request waits
 * quietly for the user to pick a passkey from the email field's autofill (the field needs
 * `autocomplete="username webauthn"`); abort it with `signal` before starting a modal one.
 */
export async function signInWithPasskey(
	options: { conditional?: boolean; next?: string; signal?: AbortSignal } = {}
): Promise<string> {
	const { credentials, pkc } = api();
	const publicKey = pkc.parseRequestOptionsFromJSON(await post('/auth/passkey/login-options'));
	const credential = await credentials.get({
		mediation: options.conditional ? 'conditional' : 'optional',
		publicKey,
		signal: options.signal,
	});
	if (!credential) throw new PasskeyClientError('No passkey was chosen');
	const result = await post('/auth/passkey/login', {
		credential: credential.toJSON(),
		next: options.next,
	});
	return String(result.redirect ?? '/');
}

/** Creates a passkey for the signed-in user and saves it under `name`. */
export async function addPasskey(name: string): Promise<void> {
	const { credentials, pkc } = api();
	const options = await post('/auth/passkey/register-options');
	const credential = await credentials.create({
		publicKey: pkc.parseCreationOptionsFromJSON(options),
	});
	if (!credential) throw new PasskeyClientError('No passkey was created');
	await post('/auth/passkey/register', { credential: credential.toJSON(), name });
}
