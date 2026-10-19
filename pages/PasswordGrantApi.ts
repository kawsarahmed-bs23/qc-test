import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/environment';

export const MOBILE_DRIVER_SCOPES = 'openid profile email quarryconnect.drivers.api offline_access';
export const CHANGE_PASSWORD_GRANT = 'urn:quarryconnect:change_password';

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
  password_errors?: string[];
}

export interface TokenResult {
  status: number;
  body: TokenResponse;
}

export interface AccountApiResponse {
  error?: string;
  error_description?: string;
  errors?: string[];
}

export interface AccountApiResult {
  status: number;
  body: AccountApiResponse | null;
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

  async changePassword(email: string, currentPassword: string, newPassword: string | null): Promise<TokenResult> {
    const form: Record<string, string> = {
      grant_type: CHANGE_PASSWORD_GRANT,
      client_id: this.clientId(),
      username: email,
      password: currentPassword,
      scope: MOBILE_DRIVER_SCOPES,
    };
    if (newPassword !== null) {
      form.new_password = newPassword;
    }
    return this.token(form);
  }

  async forgotPasswordCode(email: string, clientId: string = this.clientId()): Promise<AccountApiResult> {
    return this.accountApi('forgot', { clientId, email });
  }

  async resetWithCode(email: string, code: string, newPassword: string, clientId: string = this.clientId()): Promise<AccountApiResult> {
    return this.accountApi('reset', { clientId, email, code, newPassword });
  }

  async accountApi(action: 'forgot' | 'reset', data: unknown): Promise<AccountApiResult> {
    const response = await this.request.post(`${env.identityUrl}/api/account/password/${action}`, { data });
    const text = await response.text();
    return { status: response.status(), body: text ? (JSON.parse(text) as AccountApiResponse) : null };
  }

  async passwordPolicy(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.request.get(`${env.identityUrl}/api/account/password/policy`);
    return { status: response.status(), body: (await response.json()) as Record<string, unknown> };
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
