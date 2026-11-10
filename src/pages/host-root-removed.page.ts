import * as fs from 'fs';
import * as path from 'path';
import { devices, expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { querySingleValue, queryIdentityDb, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';
import { serviceToken } from '@api/identity-admin.api';
import { IdentityLoginPage } from '@pages/identity-login.page';

export const HOST_API_SCOPE = 'quarryconnect.api';

export const ROOT_ENDPOINTS = [
  { method: 'GET', path: '/api/environment-setting' },
  { method: 'GET', path: '/api/host-feature' },
  { method: 'GET', path: '/api/host-branding' },
  { method: 'POST', path: '/api/messaging/probes', data: { failTimes: 0, rollback: true } },
] as const;

export type RootEndpoint = (typeof ROOT_ENDPOINTS)[number];

export const QC801_ADMIN_EMAIL = 'e2e.qc801.hostadmin@quarryconnect.test';
export const QC801_SUPERADMIN_EMAIL = 'e2e.qc801.superadmin@quarryconnect.test';
export const QC801_ADMIN_STATE = path.join('.auth', env.name, 'qc801-app-admin.json');

const HOST_ORGANISATION_ID = '30';
const ROOT_ORGANISATION_ID = '1';

export function superAdminRowCounts(): { roles: number; userToRoles: number; rolesToPermissions: number; roleClaims: number } {
  const count = (sql: string) => Number(querySingleValue(sql));
  return {
    roles: count(`SELECT COUNT(*) FROM auth.Roles WHERE Name = N'SuperAdmin' OR NormalizedName = N'SUPERADMIN'`),
    userToRoles: count(`SELECT COUNT(*) FROM auth.UserToRoles WHERE RoleName = N'SuperAdmin'`),
    rolesToPermissions: count(`SELECT COUNT(*) FROM auth.RolesToPermissions WHERE RoleName = N'SuperAdmin'`),
    roleClaims: count(
      `IF OBJECT_ID(N'auth.RoleClaims', N'U') IS NULL SELECT 0 ELSE SELECT COUNT(*) FROM auth.RoleClaims rc JOIN auth.Roles r ON r.Id = rc.RoleId WHERE r.Name = N'SuperAdmin'`,
    ),
  };
}

export function seedSuperAdminRole(): void {
  runSeedScript('superadmin-role-qc801.apply.sql');
}

export function removeSuperAdminRole(): void {
  runSeedScript('superadmin-role-qc801.remove.sql');
}

export class Qc801HostUsers {
  static seed(email: string, role: 'Admin' | 'SuperAdmin'): ThrowawayUser {
    if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway host users copy that password.');
    const authenticatorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc801-user.apply.sql', {
      Email: email,
      SourceEmail: env.admin.email,
      LastName: `QC-801 ${role}`,
      TwoFactor: '1',
      AuthenticatorKey: authenticatorKey,
    });
    const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email}')`);
    if (!userId) throw new Error(`The throwaway user ${email} was not created.`);
    runSeedScript('host-qc801-user.apply.sql', {
      UserId: userId,
      Email: email,
      RoleName: role,
      OrganisationId: role === 'SuperAdmin' ? ROOT_ORGANISATION_ID : HOST_ORGANISATION_ID,
    });
    return { email, password: env.admin.password, userId, authenticatorKey };
  }

  static async signIn(browser: Browser, user: ThrowawayUser, statePath?: string): Promise<string> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/authentication');
      await new IdentityLoginPage(page).signInWithTwoStep(user, user.authenticatorKey!);
      await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { message: `${user.email} gets a host access token`, timeout: 30_000 })
        .toBeTruthy();
      const token = (await page.evaluate(() => localStorage.getItem('accessToken')))!;
      if (statePath) {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        await context.storageState({ path: statePath });
      }
      return token;
    } finally {
      await context.close();
    }
  }

  static remove(): void {
    try {
      runSeedScript('host-qc801.remove.sql');
    } finally {
      runIdentitySeedScript('identity-qc801.remove.sql', { EmailLike: 'e2e.qc801.%@quarryconnect.test' });
      fs.rmSync(QC801_ADMIN_STATE, { force: true });
    }
  }

  static remaining(): { host: number; identity: number } {
    return {
      host: Number(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC801.%'`)),
      identity: Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC801.%'`)),
    };
  }
}

export class HostRootApi {
  constructor(private readonly request: APIRequestContext) {}

  static async adminServiceToken(request: APIRequestContext): Promise<string> {
    const result = await serviceToken(request, HOST_API_SCOPE);
    if (result.status !== 200 || !result.body.access_token) {
      throw new Error(`The Admin service client could not get a ${HOST_API_SCOPE} token: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return result.body.access_token as string;
  }

  async call(endpoint: RootEndpoint, token: string): Promise<{ status: number; text: string }> {
    const response = await this.request.fetch(`${env.appApiUrl}${endpoint.path}`, {
      method: endpoint.method,
      headers: { Authorization: `Bearer ${token}` },
      data: 'data' in endpoint ? endpoint.data : undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    return { status: response.status(), text: await response.text() };
  }
}

export class HostSidebar {
  readonly root: Locator;
  readonly setupPanel: Locator;
  readonly companySettings: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('app-sidebar');
    this.setupPanel = this.root.locator('mat-expansion-panel').filter({ has: page.locator('a[routerlink="/admin/settings"]') });
    this.companySettings = this.setupPanel.locator('a[routerlink="/admin/settings"]');
  }

  link(route: string): Locator {
    return this.root.locator(`a[routerlink="${route}"]`);
  }

  setupItems(): Locator {
    return this.setupPanel.locator('.sidebar-sub-menu .sidemenu-link');
  }

  async openSetup(): Promise<void> {
    await expect(this.setupPanel).toBeVisible({ timeout: 30_000 });
    await this.setupPanel.locator('mat-expansion-panel-header').click();
    await expect(this.companySettings).toBeVisible();
  }
}

export class HostNotFoundPage {
  readonly root: Locator;
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('app-not-found');
    this.heading = this.root.locator('h3');
  }

  async open(route: string): Promise<void> {
    await this.page.goto(`/#${route}`);
  }
}
