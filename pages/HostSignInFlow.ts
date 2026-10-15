import { createHash, randomBytes } from 'crypto';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials, type OidcClient } from '../config/environment';
import { escape, IdentityLoginPage } from './IdentityLoginPage';
import { decodeJwt, type TokenResult } from './PasswordGrantApi';

export const HOST_API_SCOPES = 'openid profile quarryconnect.api';
export const NO_HOST_ACCESS = "doesn't have access to this site";

export class HostSignInFlow {
  readonly error: Locator;
  private readonly verifier = randomBytes(32).toString('base64url');
  private callbackUrl: string | null = null;

  constructor(
    private readonly page: Page,
    private readonly client: OidcClient,
  ) {
    this.error = page.locator('.custom-error-message[role="alert"]:not([hidden])');
  }

  async open(): Promise<void> {
    this.page.on('request', (request) => {
      if (!this.callbackUrl && request.url().startsWith(this.client.redirectUri)) {
        this.callbackUrl = request.url();
      }
    });
    const query = new URLSearchParams({
      client_id: this.client.clientId,
      redirect_uri: this.client.redirectUri,
      response_type: 'code',
      scope: HOST_API_SCOPES,
      code_challenge: createHash('sha256').update(this.verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state: 'e2e',
      nonce: 'e2e',
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

  async expectNoAccess(): Promise<void> {
    await expect(this.error).toContainText(NO_HOST_ACCESS);
    await new IdentityLoginPage(this.page).expectVisible();
  }

  async expectSignInError(error: string): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Error`, 'i'));
    await expect(this.page.locator('body')).toContainText(error);
  }

  async expectTwoStepEnrolment(): Promise<void> {
    await expect(this.page).toHaveURL(/\/Account\/EnableAuthenticator/i);
  }

  async exchange(request: APIRequestContext, code: string): Promise<TokenResult> {
    const response = await request.post(`${env.identityUrl}/connect/token`, {
      form: {
        grant_type: 'authorization_code',
        client_id: this.client.clientId,
        code,
        redirect_uri: this.client.redirectUri,
        code_verifier: this.verifier,
      },
    });
    return { status: response.status(), body: await response.json() };
  }

  async accessTokenClaims(request: APIRequestContext): Promise<Record<string, unknown>> {
    const result = await this.exchange(request, await this.expectCallback());
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return decodeJwt(result.body.access_token!).claims;
  }
}
