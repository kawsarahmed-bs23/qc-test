import { expect, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { runSeedScript } from '@utils/localDb';
import { BasePage } from './base.page';

export const QC993_EMAIL = 'e2e.qc993.session@quarryconnect.test';
export const LAST_ACTIVITY_KEY = 'qc_last_activity';
export const RETURN_ROUTE_KEY = 'qc_oidc_return';

export function seedQc993User(): Credentials {
  if (!env.appAdmin) throw new Error('APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD are not set; the throwaway host user copies that password.');
  runSeedScript('host-qc993-user.apply.sql', { Email: QC993_EMAIL, SourceEmail: env.appAdmin.email });
  return { email: QC993_EMAIL, password: env.appAdmin.password };
}

export function removeQc993Users(): void {
  runSeedScript('host-qc993.remove.sql');
}

export class AppPasswordSignInPage extends BasePage {
  protected readonly path = '/#/authentication';
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;

  constructor(page: Page) {
    super(page);
    this.email = page.locator('#email');
    this.password = page.locator('#password');
    this.submit = page.getByRole('button', { name: 'Sign In', exact: true });
  }

  async open(route: string = this.path): Promise<void> {
    await this.page.goto(route);
    await expect(this.email).toBeVisible({ timeout: 30_000 });
  }

  async signIn(credentials: Credentials): Promise<void> {
    await this.email.fill(credentials.email);
    await this.password.fill(credentials.password);
    await this.submit.click();
  }

  async signInAndWaitForApp(credentials: Credentials): Promise<void> {
    await this.open();
    await this.signIn(credentials);
    await expect(this.page).not.toHaveURL(/#\/authentication/, { timeout: 30_000 });
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }
}

export class IdleWarningDialog {
  readonly dialog: Locator;
  readonly title: Locator;
  readonly message: Locator;
  readonly stay: Locator;
  readonly signOut: Locator;

  constructor(page: Page) {
    this.dialog = page.locator('.idle-warning-dialog');
    this.title = this.dialog.locator('#idle-warning-title');
    this.message = this.dialog.locator('.idle-warning-message');
    this.stay = this.dialog.locator('.idle-warning-stay');
    this.signOut = this.dialog.locator('.idle-warning-sign-out');
  }

  async expectOpen(): Promise<void> {
    await expect(this.title).toHaveText('Are you still there?');
    await expect(this.message).toHaveText(/^You'll be signed out in \d+ seconds\. Stay signed in\?$/);
    await expect(this.stay).toHaveText('Stay signed in');
    await expect(this.signOut).toHaveText('Sign out');
  }
}

export class LockScreen {
  readonly overlay: Locator;
  readonly title: Locator;
  readonly message: Locator;
  readonly email: Locator;
  readonly passwordForm: Locator;
  readonly password: Locator;
  readonly passwordSubmit: Locator;
  readonly identityButton: Locator;
  readonly switchUser: Locator;
  readonly error: Locator;
  readonly inertShell: Locator;

  constructor(page: Page) {
    this.overlay = page.locator('app-lock-screen');
    this.title = page.locator('#lock-screen-title');
    this.message = page.locator('#lock-screen-message');
    this.email = page.locator('#lock-screen-email');
    this.passwordForm = page.locator('#lock-screen-password-form');
    this.password = page.locator('#lock-screen-password');
    this.passwordSubmit = this.passwordForm.locator('button[type="submit"]');
    this.identityButton = page.locator('#lock-screen-identity');
    this.switchUser = page.locator('#lock-screen-switch');
    this.error = page.locator('#lock-screen-error');
    this.inertShell = page.locator('app-root > div[inert]');
  }

  async expectLocked(email: string): Promise<void> {
    await expect(this.title).toHaveText('Session locked', { timeout: 20_000 });
    await expect(this.email).toHaveText(email);
    await expect(this.passwordForm).toBeVisible();
    await expect(this.inertShell.first()).toBeAttached();
  }

  async expectUnlocked(): Promise<void> {
    await expect(this.overlay).toHaveCount(0);
    await expect(this.inertShell).toHaveCount(0);
  }

  async unlockWithPassword(password: string): Promise<void> {
    await this.password.fill(password);
    await this.passwordSubmit.click();
  }
}

export class SessionTraffic {
  readonly refreshStatuses: number[] = [];
  readonly pageRoutes: string[] = [];

  constructor(private readonly page: Page) {
    page.on('response', (response) => {
      if (response.url().endsWith('/api/account/refreshtoken')) this.refreshStatuses.push(response.status());
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.pageRoutes.push(frame.url());
    });
  }

  async answerNextApiCall(status: number, pathPattern: RegExp): Promise<{ hits: () => number }> {
    let hits = 0;
    await this.page.route(pathPattern, async (route) => {
      hits++;
      if (hits === 1) await route.fulfill({ status, contentType: 'application/json', body: '{}' });
      else await route.fallback();
    });
    return { hits: () => hits };
  }

  async answerNextRefresh(status: number): Promise<{ hits: () => number }> {
    return this.answerNextApiCall(status, /\/api\/account\/refreshtoken$/);
  }

  forgetRoutesSoFar(): void {
    this.pageRoutes.length = 0;
  }

  signedOutRoutes(): string[] {
    return this.pageRoutes.filter((url) => /#\/authentication/.test(url));
  }
}

export class SessionStorageProbe {
  constructor(private readonly page: Page) {}

  setLastActivityAgo(milliseconds: number): Promise<number> {
    return this.page.evaluate(
      ({ key, ago }) => {
        const value = Date.now() - ago;
        localStorage.setItem(key, String(value));
        return value;
      },
      { key: LAST_ACTIVITY_KEY, ago: milliseconds },
    );
  }

  async idleTimeoutMs(): Promise<number> {
    const response = await this.page.request.get(`${env.appApiUrl}/api/account/signinmode`);
    const body = (await response.json()) as { data: { idleTimeoutMinutes: number } };
    return body.data.idleTimeoutMinutes * 60_000;
  }

  lastActivity(): Promise<number> {
    return this.page.evaluate((key) => Number(localStorage.getItem(key) ?? 0), LAST_ACTIVITY_KEY);
  }

  accessToken(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem('accessToken'));
  }

  refreshToken(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem('refreshToken'));
  }

  setRefreshToken(value: string): Promise<void> {
    return this.page.evaluate((token) => localStorage.setItem('refreshToken', token), value);
  }

  returnRoute(): Promise<string | null> {
    return this.page.evaluate((key) => sessionStorage.getItem(key), RETURN_ROUTE_KEY);
  }

  setReturnRoute(route: string): Promise<void> {
    return this.page.evaluate(([key, value]) => sessionStorage.setItem(key, value), [RETURN_ROUTE_KEY, route]);
  }

  accessTokenLifetimeSeconds(): Promise<number> {
    return this.page.evaluate(() => {
      const payload = JSON.parse(atob((localStorage.getItem('accessToken') ?? '..').split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return payload.exp - payload.iat;
    });
  }
}
