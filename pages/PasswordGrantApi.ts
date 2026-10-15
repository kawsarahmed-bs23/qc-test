import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/environment';

export const MOBILE_DRIVER_SCOPES = 'openid profile email quarryconnect.drivers.api offline_access';

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface TokenResult {
  status: number;
  body: TokenResponse;
}

export class PasswordGrantApi {
  constructor(private readonly request: APIRequestContext) {}

  async passwordGrant(email: string, password: string): Promise<TokenResult> {
    return this.token({
      grant_type: 'password',
      client_id: this.clientId(),
      username: email,
      password,
      scope: MOBILE_DRIVER_SCOPES,
    });
  }

  async refresh(refreshToken: string): Promise<TokenResult> {
    return this.token({ grant_type: 'refresh_token', client_id: this.clientId(), refresh_token: refreshToken });
  }

  async revoke(refreshToken: string): Promise<number> {
    const response = await this.request.post(`${env.identityUrl}/connect/revocation`, {
      form: { client_id: this.clientId(), token: refreshToken, token_type_hint: 'refresh_token' },
    });
    return response.status();
  }

  async driversMe(accessToken: string): Promise<APIResponse> {
    if (!env.driversApiUrl) {
      throw new Error('DRIVERS_API_URL is not set.');
    }
    return this.request.get(`${env.driversApiUrl}/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  }

  private clientId(): string {
    if (!env.mobileClientId) {
      throw new Error('MOBILE_CLIENT_ID is not set.');
    }
    return env.mobileClientId;
  }

  private async token(form: Record<string, string>): Promise<TokenResult> {
    const response = await this.request.post(`${env.identityUrl}/connect/token`, { form });
    return { status: response.status(), body: (await response.json()) as TokenResponse };
  }
}

export function decodeJwt(token: string): { header: Record<string, unknown>; claims: Record<string, unknown> } {
  const [header, claims] = token.split('.').slice(0, 2).map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')));
  return { header, claims };
}
