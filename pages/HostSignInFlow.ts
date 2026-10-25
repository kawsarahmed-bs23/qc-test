import { createHash, randomBytes } from 'crypto';
import { expect, request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials, type OidcClient } from '../config/environment';
import { escape, IdentityLoginPage } from './IdentityLoginPage';
import { decodeJwt, type TokenResult } from './PasswordGrantApi';

export const HOST_API_SCOPES = 'openid profile quarryconnect.api';
const FLOW_STATE = 'e2e';

export class HostSignInFlow {
  readonly error: Locator;
  private readonly verifier = randomBytes(32).toString('base64url');
  private callbackUrl: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly client: OidcClient,
    private readonly scope: string = HOST_API_SCOPES,
  ) {
    this.error = page.locator('.custom-error-message[role="alert"]:not([hidden])');
  }

  async open(extra: Record<string, string> = {}): Promise<void> {
    this.page.on('request', (request) => {
      if (!this.callbackUrl && request.url().startsWith(this.client.redirectUri) && isFlowCallback(request.url())) {
        this.callbackUrl = request.url();
      }
    });
    const query = new URLSearchParams({
      client_id: this.client.clientId,
      redirect_uri: this.client.redirectUri,
      response_type: 'code',
      scope: this.scope,
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: FLOW_STATE,
      nonce: 'e2e',
      ...extra,
    });
    await this.page.goto(`${env.identityUrl}/connect/authorize?${query}`).catch((error: Error) => {
      if (!this.callbackUrl) throw error;
    });
  }

  async signIn(credentials: Credentials): Promise<void> {
    await this.open();
    await new IdentityLoginPage(this.page).signIn(credentials);
  }

  async expectCallback(): Promise<string> {
    await expect.poll(() => this.callbackUrl, { message: `redirect to ${this.client.redirectUri}`, timeout: 30_000 }).not.toBeNull();
    const callback = new URL(this.callbackUrl!);
    expect(callback.searchParams.get('error'), 'authorize error').toBeNull();
    const code = callback.searchParams.get('code');
    expect(code, 'authorization code on the client callback').toBeTruthy();
    return code!;
  }

  async expectSignInError(error: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Error`, 'i'));
    await expect(this.page.locator('body')).toContainText(error);
  }

  async expectTwoStepEnrolment(): Promise<void> {
    await expect(this.page).toHaveURL(/\/Account\/EnableAuthenticator/i);
  }

  async exchange(request: APIRequestContext, code: string, extra: Record<string, string> = {}): Promise<TokenResult> {
    const response = await request.post(`${env.identityUrl}/connect/token`, {
      form: {
        grant_type: 'authorization_code',
        client_id: this.client.clientId,
        code,
        redirect_uri: this.client.redirectUri,
        code_verifier: this.verifier,
        ...extra,
      },
    });
    return { status: response.status(), body: await response.json() };
  }

  async accessTokenClaims(request: APIRequestContext): Promise<Record<string, unknown>> {
    return (await this.tokens(request)).access;
  }

  async tokens(request: APIRequestContext): Promise<{ accessToken: string; access: Record<string, unknown>; id: Record<string, unknown> }> {
    const result = await this.exchange(request, await this.expectCallback());
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return {
      accessToken: result.body.access_token!,
      access: decodeJwt(result.body.access_token!).claims,
      id: decodeJwt(result.body.id_token!).claims,
    };
  }
}

function isFlowCallback(url: string): boolean {
  const query = new URL(url).searchParams;
  return query.get('state') === FLOW_STATE && (query.has('code') || query.has('error'));
}

export async function identityLanding(url: string): Promise<string> {
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
  try {
    let next = url;
    for (let hop = 0; hop < 10; hop++) {
      const response = await request.get(next, { maxRedirects: 0 });
      const location = response.headers()['location'];
      if (!location) {
        return next;
      }
      next = new URL(location, next).toString();
      if (!next.startsWith(env.identityUrl)) {
        return next;
      }
    }
    throw new Error(`More than 10 redirects from ${url}`);
  } finally {
    await request.dispose();
  }
}

export function authorizeUrl(query: Record<string, string>): string {
  return `${env.identityUrl}/connect/authorize?${new URLSearchParams({
    response_type: 'code',
    scope: HOST_API_SCOPES,
    code_challenge: createHash('sha256').update('e2e-qc775-verifier-with-enough-length-0123456789').digest('base64url'),
    code_challenge_method: 'S256',
    state: 'e2e',
    ...query,
  })}`;
}
