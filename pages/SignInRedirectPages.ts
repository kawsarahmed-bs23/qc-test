import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '../fixtures/localDb';
import type { ThrowawayUser } from '../fixtures/throwawayUsers';
import { newAuthenticatorKey } from '../fixtures/totp';

export const QC826_EMAIL_LIKE = 'e2e.qc826.%@quarryconnect.test';

export function qc826Email(name: string): string {
  return `e2e.qc826.${name}@quarryconnect.test`;
}

export function seedQc826User(email: string, lastName: string, hostAccount: boolean): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const authenticatorKey = newAuthenticatorKey();
  runIdentitySeedScript('identity-qc826-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: lastName,
    TwoFactor: '1',
    AuthenticatorKey: authenticatorKey,
  });
  const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  if (hostAccount) {
    runSeedScript('host-qc826-admin.apply.sql', { UserId: userId, Email: email });
  }
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function removeQc826Users(): void {
  runSeedScript('host-qc826.remove.sql');
  runIdentitySeedScript('identity-qc826.remove.sql', { EmailLike: QC826_EMAIL_LIKE });
}

export class SignInWatch {
  readonly locations: string[] = [];
  readonly requests: string[] = [];
  readonly timeline: { kind: 'location' | 'request'; url: string }[] = [];
  private signInPageSeen = false;

  private constructor(private readonly page: Page) {}

  static async attach(page: Page, appTag = 'app-sign-in'): Promise<SignInWatch> {
    const watch = new SignInWatch(page);
    await page.exposeBinding('qcE2eLocation', (_source, url: string) => watch.addLocation(url));
    await page.exposeBinding('qcE2eSignInPage', () => {
      watch.signInPageSeen = true;
    });
    await page.addInitScript((tag: string) => {
      const w = window as unknown as { qcE2eLocation(url: string): void; qcE2eSignInPage(): void };
      const report = () => w.qcE2eLocation(location.href);
      report();
      for (const name of ['pushState', 'replaceState'] as const) {
        const original = history[name].bind(history);
        history[name] = (...args: Parameters<History['pushState']>) => {
          original(...args);
          report();
        };
      }
      addEventListener('hashchange', report);
      new MutationObserver(() => {
        if (document.querySelector(tag)) w.qcE2eSignInPage();
      }).observe(document, { childList: true, subtree: true });
    }, appTag);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) watch.addLocation(frame.url());
    });
    page.on('request', (request) => {
      watch.requests.push(request.url());
      watch.timeline.push({ kind: 'request', url: request.url() });
    });
    return watch;
  }

  private addLocation(url: string): void {
    this.locations.push(url);
    this.timeline.push({ kind: 'location', url });
  }

  locationsAfterRequest(prefix: string): string[] {
    const start = this.timeline.findIndex((e) => e.kind === 'request' && e.url.startsWith(prefix));
    return start < 0 ? [] : this.timeline.slice(start + 1).filter((e) => e.kind === 'location').map((e) => e.url);
  }

  get sawSignInPage(): boolean {
    return this.signInPageSeen;
  }

  appLocations(appUrl: string): string[] {
    return this.locations.filter((url) => url.startsWith(appUrl));
  }

  locationsWithRoute(route: string): string[] {
    return this.locations.filter((url) => new RegExp(`#${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?|$)`).test(url));
  }

  identityAuthorizes(): URL[] {
    return this.requests.filter((url) => url.startsWith(`${env.identityUrl}/connect/authorize?`)).map((url) => new URL(url));
  }

  discoveryRequests(): string[] {
    return this.requests.filter((url) => url.includes('/.well-known/openid-configuration'));
  }

  identityRequests(): string[] {
    return this.requests.filter((url) => url.startsWith(env.identityUrl));
  }

  endSessions(): URL[] {
    return this.requests.filter((url) => url.startsWith(`${env.identityUrl}/connect/endsession`)).map((url) => new URL(url));
  }

  reset(): void {
    this.locations.length = 0;
    this.requests.length = 0;
    this.timeline.length = 0;
    this.signInPageSeen = false;
  }
}

export class HostAppHeader {
  readonly profileMenuButton: Locator;
  readonly profileMenu: Locator;
  readonly logout: Locator;

  constructor(private readonly page: Page) {
    this.profileMenuButton = page.locator('app-header .profile-menu-btn');
    this.profileMenu = page.locator('.profile-menu-dropdown');
    this.logout = this.profileMenu.locator('li', { hasText: 'Logout' }).locator('a');
  }

  async dismissDevServerOverlay(): Promise<void> {
    const overlay = this.page.locator('vite-error-overlay');
    if (await overlay.count()) {
      await this.page.keyboard.press('Escape');
      await expect(overlay).toHaveCount(0);
    }
  }

  async signOut(): Promise<void> {
    await this.dismissDevServerOverlay();
    await this.profileMenuButton.click();
    await expect(this.logout).toBeVisible();
    await this.logout.click();
  }
}

export class AppSignInErrorView {
  readonly root: Locator;
  readonly message: Locator;
  readonly tryAgain: Locator;
  readonly differentAccount: Locator;

  constructor(page: Page) {
    this.root = page.locator('app-sign-in');
    this.message = this.root.locator('.custom-error-message');
    this.tryAgain = this.root.getByRole('button', { name: 'Try again' });
    this.differentAccount = this.root.getByRole('button', { name: 'Sign in with a different account' });
  }

  async expectVisible(): Promise<void> {
    await expect(this.message).toBeVisible({ timeout: 30_000 });
    await expect(this.tryAgain).toBeVisible();
    await expect(this.differentAccount).toBeVisible();
  }
}

export class AppTermsPage {
  readonly root: Locator;
  readonly heading: Locator;

  constructor(page: Page) {
    this.root = page.locator('app-terms');
    this.heading = this.root.getByRole('heading', { name: 'Terms of Service' });
  }
}

export const APP_DEEP_LINK = '/dispatch/schedule-comparison';

export function appDeepLinkHeading(page: Page): Locator {
  return page.getByRole('heading', { name: 'Schedule — Plan vs Live' });
}
