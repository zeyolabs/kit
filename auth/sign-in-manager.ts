import type { RequestEvent } from '@sveltejs/kit';

import { json, redirect } from '@sveltejs/kit';
import { z } from 'zod';

import type { LoginError } from './login';
import type { AuthUser } from './sign-in';

import { TurnstileClient } from '../cloudflare/turnstile/client';
import { logger } from '../server/logger';
import { envStore } from '../utils/env';
import { ServiceError } from '../utils/errors';
import { AccountService } from './accounts/accounts';
import { Auth } from './config';
import { Login } from './login';
import { AuthHandle } from './sessions/handle';
import {
	AuthenticationResponse,
	PasskeyError,
	Passkeys,
	RegistrationResponse,
	type RelyingParty,
} from './sessions/passkeys/passkeys';
import { SignInService } from './sign-in';

const CHALLENGE_MAX_AGE = 5 * 60;

/**
 * The auth endpoints for one request (`routes.ts` dispatches to it): the email link, the passkey
 * ceremonies, sign-out and accepting an invite. It owns what is specific to the request, the
 * cookies, redirects and JSON answers, and leaves the sign-in rules to `SignInService`.
 */
export class SignInManager {
	private readonly signIn: SignInService;

	constructor(private readonly event: RequestEvent) {
		const { db, turnstile } = Auth.config();
		this.signIn = new SignInService(
			db(),
			turnstile
				? new TurnstileClient(envStore(), turnstile.secretName, turnstile.siteKeyName)
				: null
		);
	}

	/** Accepts an invite for the signed-in user (the invite page posts here) and opens the account. */
	async acceptInvite(): Promise<never> {
		const form = await this.event.request.formData();
		const token = String(form.get('token') ?? '');
		const { user } = AuthHandle.locals(this.event);
		const invitePage = `${Auth.config().invitePath}?token=${encodeURIComponent(token)}`;
		if (!user) this.toLogin(null, invitePage);
		const { accounts, db } = Auth.config();
		const account = await new AccountService(db(), accounts)
			.acceptInvite(token, user)
			.catch((err: unknown) => {
				if (err instanceof ServiceError) redirect(303, `${invitePage}&error=${err.status}`);
				throw err;
			});
		redirect(303, Auth.config().accountHome(account.slug));
	}

	async emailLink(): Promise<never> {
		const form = await this.event.request.formData();
		const next = Login.safeNext(form.get('next'));
		const { error, sent } = await this.signIn.requestLink({
			accessEmail: AuthHandle.locals(this.event).accessEmail,
			email: form.get('email'),
			hostname: this.event.url.hostname,
			ip: this.event.getClientAddress(),
			next,
			origin: this.event.url.origin,
			turnstileToken: String(form.get('turnstileToken') ?? ''),
		});
		this.toLogin(error, next, sent);
	}

	async logout(): Promise<never> {
		const { session } = AuthHandle.locals(this.event);
		if (session) await this.signIn.deleteSession(session.id);
		this.event.cookies.delete(Auth.config().cookieName, {
			domain: Auth.config().cookieDomain,
			path: '/',
		});
		redirect(303, Auth.config().loginPath);
	}

	async passkeyDelete(): Promise<never> {
		const form = await this.event.request.formData();
		const next = Login.safeNext(form.get('next'));
		const user = this.sessionUser(false);
		if (user instanceof Response) this.toLogin(null, next);
		await this.signIn.deletePasskey(user.id, String(form.get('id') ?? ''));
		redirect(303, next);
	}

	async passkeyLogin(): Promise<Response> {
		const body = z
			.object({ credential: AuthenticationResponse, next: z.string().optional() })
			.safeParse(await this.event.request.json().catch(() => null));
		if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
		try {
			const challenge = this.takeChallenge();
			const passkey = await this.signIn.findPasskey(body.data.credential.rawId);
			if (!passkey) throw new PasskeyError('Unknown passkey');
			const signCount = Passkeys.verifyAuthentication(
				body.data.credential,
				challenge,
				this.relyingParty(),
				passkey
			);
			const user = await this.signIn.findUser(passkey.userId);
			const refused = await this.refusal(user.email);
			if (refused) return json({ code: refused, message: 'Not allowed' }, { status: 403 });
			await this.signIn.recordPasskeyUse(passkey.id, signCount);
			await this.startSession(user);
			return json({ redirect: Login.safeNext(body.data.next) });
		} catch (err) {
			if (!(err instanceof PasskeyError)) throw err;
			logger.warn(`passkey sign-in refused: ${err.message}`);
			return json({ message: 'That passkey could not be verified' }, { status: 400 });
		}
	}

	passkeyLoginOptions(): Response {
		return json(Passkeys.authenticationOptions(this.relyingParty(), this.setChallenge()));
	}

	async passkeyRegister(): Promise<Response> {
		const user = this.sessionUser(true);
		if (user instanceof Response) return user;
		const body = z
			.object({ credential: RegistrationResponse, name: z.string().trim().max(60).optional() })
			.safeParse(await this.event.request.json().catch(() => null));
		if (!body.success) return json({ message: 'Malformed request' }, { status: 400 });
		try {
			const credential = Passkeys.verifyRegistration(
				body.data.credential,
				this.takeChallenge(),
				this.relyingParty()
			);
			await this.signIn.savePasskey(user.id, body.data.name || 'Passkey', credential);
			return json({ ok: true });
		} catch (err) {
			if (!(err instanceof PasskeyError)) throw err;
			logger.warn(`passkey registration refused: ${err.message}`);
			return json({ message: 'That passkey could not be added' }, { status: 400 });
		}
	}

	async passkeyRegisterOptions(): Promise<Response> {
		const user = this.sessionUser(true);
		if (user instanceof Response) return user;
		const existing = await this.signIn.listPasskeys(user.id);
		return json(
			Passkeys.registrationOptions(
				this.relyingParty(),
				user,
				this.setChallenge(),
				existing.map((p) => p.id)
			)
		);
	}

	async verifyLink(): Promise<never> {
		const form = await this.event.request.formData();
		const next = Login.safeNext(form.get('next'));
		const email = await this.signIn.consumeLink(String(form.get('token') ?? ''));
		if (!email) this.toLogin('expired', next);
		const refused = await this.refusal(email);
		if (refused) this.toLogin(refused, next);
		await this.startSession(await this.signIn.findOrCreateUser(email));
		redirect(303, next);
	}

	private challengeCookie(): string {
		return `${Auth.config().cookieName}_challenge`;
	}

	/** Checks a would-be session user against the allowlist and the Access identity. */
	private refusal(email: string): Promise<LoginError | null> {
		return SignInService.refusal(email, AuthHandle.locals(this.event).accessEmail);
	}

	private relyingParty(): RelyingParty {
		const { appName, passkeyRpId } = Auth.config();
		return {
			id: passkeyRpId ?? this.event.url.hostname,
			name: appName,
			origin: this.event.url.origin,
		};
	}

	/** Adding or removing a passkey needs a session, and adding one needs a recent sign-in. */
	private sessionUser(fresh: boolean): AuthUser | Response {
		const { session, user } = AuthHandle.locals(this.event);
		if (!session || !user) return json({ message: 'Sign in first' }, { status: 401 });
		if (fresh && Date.now() - session.createdAt > Passkeys.FRESH_SESSION_MS) {
			return json(
				{ message: 'For security, sign in again before adding a passkey', reauth: true },
				{ status: 403 }
			);
		}
		return user;
	}

	private setChallenge(): string {
		const challenge = Passkeys.newChallenge();
		this.event.cookies.set(this.challengeCookie(), challenge, {
			...SignInService.cookieAttributes,
			maxAge: CHALLENGE_MAX_AGE,
			path: '/auth/passkey',
			sameSite: 'strict',
		});
		return challenge;
	}

	private async startSession(user: AuthUser): Promise<void> {
		const { expiresAt, token } = await this.signIn.createSession(user.id);
		this.event.cookies.set(Auth.config().cookieName, token, {
			...SignInService.cookieAttributes,
			domain: Auth.config().cookieDomain,
			expires: new Date(expiresAt),
		});
		await Auth.config().onSignIn?.(user);
	}

	/** The pending challenge, used up: each one answers exactly one ceremony. */
	private takeChallenge(): string {
		const challenge = this.event.cookies.get(this.challengeCookie());
		this.event.cookies.delete(this.challengeCookie(), { path: '/auth/passkey' });
		if (!challenge) throw new PasskeyError('No pending challenge');
		return challenge;
	}

	private toLogin(error: LoginError | null, next: string, sent = false): never {
		const params = new URLSearchParams();
		if (error) params.set('error', error);
		if (sent) params.set('sent', '1');
		if (next !== '/') params.set('next', next);
		const query = params.toString();
		redirect(303, `${Auth.config().loginPath}${query ? `?${query}` : ''}`);
	}
}
