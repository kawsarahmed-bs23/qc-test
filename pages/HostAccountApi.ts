import { createHash } from 'crypto';
import type { APIRequestContext, Page } from '@playwright/test';
import { env, type Credentials } from '../config/environment';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '../fixtures/localDb';
import type { ThrowawayUser } from '../fixtures/throwawayUsers';
import { newAuthenticatorKey } from '../fixtures/totp';
import { IdentityLoginPage, IdentityTwoStepPage } from './IdentityLoginPage';
import { HostSignInFlow } from './HostSignInFlow';
import { decodeJwt } from './PasswordGrantApi';

export const DEVICE_ID_HEADER = 'X-Device-Id';
export const DEVICE_ID_CLAIM = 'DeviceId';
const QC726_EMAIL_LIKE = 'e2e.qc726.%@quarryconnect.test';

export function qc726Email(name: string): string {
  return `e2e.qc726.${name}@quarryconnect.test`;
}

export function seedQc726HostUser(email: string, roleName: 'Admin' | 'Driver', twoFactor: boolean): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const authenticatorKey = twoFactor ? newAuthenticatorKey() : null;
  runIdentitySeedScript('identity-qc726-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: `QC-726 ${roleName}`,
    TwoFactor: twoFactor ? '1' : '0',
    AuthenticatorKey: authenticatorKey ?? 'none',
  });
  const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  runSeedScript('host-qc726-user.apply.sql', { UserId: userId, Email: email, RoleName: roleName });
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function removeQc726HostUsers(): void {
  runSeedScript('host-qc726.remove.sql');
  runIdentitySeedScript('identity-qc726.remove.sql', { EmailLike: QC726_EMAIL_LIKE });
}

export interface HostTokens {
  accessToken: string;
  refreshToken: string;
}

export interface HostApiResult<T = unknown> {
  status: number;
  data: T | null;
  body: Record<string, unknown> | null;
}

export function deviceIdClaimValue(deviceId: string): string {
  return createHash('sha256').update(deviceId.trim().toLowerCase(), 'utf8').digest('hex');
}

export function hostUserId(tokens: HostTokens): string {
  return String(decodeJwt(tokens.accessToken).claims['UserId']);
}

export async function identityAccessToken(
  page: Page,
  request: APIRequestContext,
  credentials: Credentials,
  authenticatorKey: string | null = null,
): Promise<string> {
  const flow = new HostSignInFlow(page, env.hostClient!);
  await flow.open();
  const identityOrigin = new URL(env.identityUrl).origin;
  if (page.url().startsWith(`${identityOrigin}/Account/Login`)) {
    await new IdentityLoginPage(page).signIn(credentials);
    await page.waitForURL((url) => url.origin !== identityOrigin || /\/Account\/LoginWith2fa/i.test(url.pathname), { timeout: 30_000 }).catch(() => undefined);
    if (/\/Account\/LoginWith2fa/i.test(new URL(page.url()).pathname)) {
      if (!authenticatorKey) {
        throw new Error(`Identity asks ${credentials.email} for two-step verification and no authenticator key is set.`);
      }
      await new IdentityTwoStepPage(page).verify(authenticatorKey);
    }
  }
  return (await flow.tokens(request)).accessToken;
}

export class HostAccountApi {
  constructor(private readonly request: APIRequestContext) {}

  private url(path: string): string {
    if (!env.appApiUrl) {
      throw new Error('APP_API_URL is not set.');
    }
    return `${env.appApiUrl}${path}`;
  }

  private headers(deviceId: string | null, accessToken: string | null = null): Record<string, string> {
    const headers: Record<string, string> = {};
    if (deviceId) headers[DEVICE_ID_HEADER] = deviceId;
    if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
    return headers;
  }

  private async read<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<HostApiResult<T>> {
    const text = await response.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    return { status: response.status(), data: (body?.['data'] as T) ?? null, body };
  }

  async identityExchange(identityAccessToken: string, deviceId: string | null = null): Promise<HostApiResult<HostTokens>> {
    const response = await this.request.post(this.url('/api/account/identityexchange'), {
      headers: this.headers(deviceId),
      data: { accessToken: identityAccessToken },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    return this.read<HostTokens>(response);
  }

  async refresh(tokens: HostTokens, deviceId: string | null = null): Promise<HostApiResult<HostTokens>> {
    const response = await this.request.post(this.url('/api/account/refreshtoken'), {
      headers: this.headers(deviceId),
      data: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    return this.read<HostTokens>(response);
  }

  async get<T = unknown>(path: string, accessToken: string, deviceId: string | null = null): Promise<HostApiResult<T>> {
    const response = await this.request.get(this.url(path), {
      headers: this.headers(deviceId, accessToken),
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    return this.read<T>(response);
  }

  userProfile(accessToken: string, deviceId: string | null = null): Promise<HostApiResult> {
    return this.get('/api/account/getuserprofile', accessToken, deviceId);
  }

  commsThreads(accessToken: string): Promise<HostApiResult<unknown[]>> {
    return this.get<unknown[]>('/api/dispatch/messages/threads', accessToken);
  }

  commsThread(driverUserId: string, accessToken: string): Promise<HostApiResult<{ driverUsesApp: boolean }>> {
    return this.get<{ driverUsesApp: boolean }>(`/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}`, accessToken);
  }
}
