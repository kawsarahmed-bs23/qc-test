import type { APIRequestContext, Browser } from '@playwright/test';
import { env } from '@config/env.config';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';
import { AppSignInPage } from '@pages/app.page';

export const QC744_EMAIL_LIKE = 'e2e.qc744.%@quarryconnect.test';

export interface HostEnvironmentSetting {
  groupName: string;
  propertyName: string;
  value: string | null;
  isSensitive: boolean;
  hasValue: boolean;
}

export function qc744Email(name: string): string {
  return `e2e.qc744.${name}@quarryconnect.test`;
}

export function seedHostSuperAdmin(email = qc744Email('superadmin')): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const authenticatorKey = newAuthenticatorKey();
  runIdentitySeedScript('identity-qc744-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: 'QC-744 Super admin',
    TwoFactor: '1',
    AuthenticatorKey: authenticatorKey,
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  runSeedScript('host-qc744-superadmin.apply.sql', { UserId: userId, Email: email });
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function removeHostSuperAdmins(): void {
  runSeedScript('host-qc744.remove.sql');
  runIdentitySeedScript('identity-qc744.remove.sql', { EmailLike: QC744_EMAIL_LIKE });
}

export async function hostAppAccessToken(browser: Browser, user: ThrowawayUser): Promise<string | null> {
  const context = await browser.newContext({ baseURL: env.appUrl!, ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const signIn = new AppSignInPage(page);
    await signIn.open();
    await signIn.signIn(user, user.authenticatorKey);
    return await page.evaluate(() => localStorage.getItem('accessToken'));
  } finally {
    await context.close();
  }
}

export async function hostEnvironmentSettings(
  request: APIRequestContext,
  token: string,
): Promise<{ status: number; body: unknown; settings: HostEnvironmentSetting[] }> {
  const response = await request.get(`${env.appApiUrl}/api/environment-setting`, {
    headers: { Authorization: `Bearer ${token}` },
    ignoreHTTPSErrors: env.ignoreHttpsErrors,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const record = body as { groups?: unknown; data?: unknown } | null;
  const groups = (Array.isArray(body) ? body : (record?.groups ?? record?.data ?? [])) as { settings?: HostEnvironmentSetting[] }[];
  return { status: response.status(), body, settings: Array.isArray(groups) ? groups.flatMap((group) => group.settings ?? []) : [] };
}
