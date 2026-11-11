import { expect, request as playwrightRequest, type BrowserContext, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { AppSignInPage } from '@pages/app.page';
import { BasePage } from '@pages/base.page';
import { escape, IdentityLoginPage } from '@pages/identity-login.page';
import { HostAppHeader } from '@pages/sign-in-redirect.page';
import { randomUUID } from 'crypto';
import { queryIdentityDb, querySingleValue, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';

export const QC616_EMAIL = 'e2e.qc616.cutover@quarryconnect.test';

/** A throwaway host admin copied into Identity the way copy_host_users.sql does, with the host password of APP_ADMIN_EMAIL. */
export function seedQc616User(): ThrowawayUser {
  if (!env.appAdmin || !env.localSql) {
    throw new Error('APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD and the host database are needed; the throwaway user copies that host password.');
  }
  const userId = randomUUID();
  runSeedScript('host-qc616-user.apply.sql', { UserId: userId, Email: QC616_EMAIL, SourceEmail: env.appAdmin.email });
  const authenticatorKey = newAuthenticatorKey();
  runIdentitySeedScript('identity-qc616-user.apply.sql', { Email: QC616_EMAIL, HostDatabase: env.localSql.database, AuthenticatorKey: authenticatorKey });
  return { email: QC616_EMAIL, password: env.appAdmin.password, userId, authenticatorKey };
}

export function removeQc616Users(): void {
  runSeedScript('host-qc616.remove.sql');
  runIdentitySeedScript('identity-qc616.remove.sql');
}

export function qc616UsersLeft(): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC616.%'`));
}

export const IDENTITY_LOGIN = new RegExp(`^${escape(env.identityUrl)}/Account/Login`, 'i');
export const SESSION_HUB_PATH = '/hubs/session';

export interface TabEvent {
  at: number;
  kind: 'location' | 'recheck' | 'hub' | 'logout';
  url: string;
}

/**
 * One browser tab of the host app (QC-616). It records where the tab goes, when it opens the
 * session hub socket and when it calls `checkrefreshtoken` or `logout`, so a case can tell which
 * path (push, other tab, focus re-check) ended the session.
 */
export class HostAppTab extends BasePage {
  protected readonly path = `${env.appUrl ?? ''}/`;
  readonly header: HostAppHeader;
  readonly events: TabEvent[] = [];

  private constructor(page: Page) {
    super(page);
    this.header = new HostAppHeader(page);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.record('location', frame.url());
    });
    page.on('websocket', (socket) => {
      if (socket.url().includes(SESSION_HUB_PATH)) this.record('hub', socket.url());
    });
    page.on('request', (request) => {
      const url = request.url();
      if (/\/api\/account\/checkrefreshtoken$/i.test(url)) this.record('recheck', url);
      if (/\/api\/account\/logout$/i.test(url)) this.record('logout', url);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && url.startsWith(env.identityUrl)) this.record('location', url);
    });
  }

  static async open(context: BrowserContext): Promise<HostAppTab> {
    return new HostAppTab(await context.newPage());
  }

  get tab(): Page {
    return this.page;
  }

  async signIn(credentials: Credentials, authenticatorKey: string | null): Promise<void> {
    await this.page.goto(this.path);
    await new IdentityLoginPage(this.page).expectVisible();
    await new AppSignInPage(this.page).signIn(credentials, authenticatorKey);
    await this.expectSignedIn();
  }

  async openSignedIn(): Promise<void> {
    await this.page.goto(this.path);
    await this.expectSignedIn();
  }

  async expectSignedIn(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.appUrl ?? '')}`));
    await expect(this.page).not.toHaveURL(/#\/authentication/);
    await expect.poll(() => this.accessToken(), { message: 'accessToken in localStorage', timeout: 30_000 }).not.toBeNull();
    await expect(this.header.profileMenuButton).toBeVisible({ timeout: 30_000 });
  }

  async expectSessionHubConnected(): Promise<void> {
    await expect.poll(() => this.events.some((e) => e.kind === 'hub'), { message: `a websocket to ${SESSION_HUB_PATH}`, timeout: 30_000 }).toBe(true);
  }

  async accessToken(): Promise<string | null> {
    return this.page.evaluate(() => localStorage.getItem('accessToken')).catch(() => null);
  }

  /** The host app's accessToken in this tab's context, read without loading the app (the tab may be on Identity). */
  async appAccessToken(): Promise<string | null> {
    const state = await this.page.context().storageState();
    const origin = new URL(env.appUrl ?? 'http://invalid').origin;
    return state.origins.find((o) => o.origin === origin)?.localStorage.find((item) => item.name === 'accessToken')?.value ?? null;
  }

  async appRefreshToken(): Promise<string | null> {
    const state = await this.page.context().storageState();
    const origin = new URL(env.appUrl ?? 'http://invalid').origin;
    return state.origins.find((o) => o.origin === origin)?.localStorage.find((item) => item.name === 'refreshToken')?.value ?? null;
  }

  async isInApp(): Promise<boolean> {
    return this.page.url().startsWith(env.appUrl ?? 'app-url-not-set') && (await this.header.profileMenuButton.isVisible());
  }

  async userAgent(): Promise<string> {
    return this.page.evaluate(() => navigator.userAgent);
  }

  async signOut(): Promise<void> {
    await this.header.signOut();
  }

  async focus(): Promise<void> {
    await this.page.bringToFront();
    await this.page.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => undefined);
  }

  async expectOnIdentityLogin(timeout: number): Promise<number> {
    await expect(this.page).toHaveURL(IDENTITY_LOGIN, { timeout });
    return this.firstAt('location', IDENTITY_LOGIN) ?? Date.now();
  }

  /** When the tab first left the app for Identity (authorize or login) at or after `since`. */
  leftForIdentityAt(since: number): number | undefined {
    return this.events.find((e) => e.kind === 'location' && e.at >= since && e.url.startsWith(env.identityUrl))?.at;
  }

  firstAt(kind: TabEvent['kind'], url?: RegExp, since = 0): number | undefined {
    return this.events.find((e) => e.kind === kind && e.at >= since && (!url || url.test(e.url)))?.at;
  }

  private record(kind: TabEvent['kind'], url: string): void {
    this.events.push({ at: Date.now(), kind, url });
  }
}

/** Revokes a host session the way the app's own sign-out does, from outside the browser. */
export async function revokeHostSession(accessToken: string, userAgent: string): Promise<number> {
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, userAgent });
  try {
    const response = await request.post(`${env.appApiUrl}/api/account/logout`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return response.status();
  } finally {
    await request.dispose();
  }
}

export async function refreshTokenIsValid(refreshToken: string): Promise<boolean> {
  const request = await playwrightRequest.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
  try {
    const response = await request.post(`${env.appApiUrl}/api/account/checkrefreshtoken`, { data: { refreshToken } });
    const body = (await response.json()) as { data?: { isValid?: boolean; IsValid?: boolean } };
    return Boolean(body.data?.isValid ?? body.data?.IsValid);
  } finally {
    await request.dispose();
  }
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

export interface IdentitySessionRow {
  id: number;
  idleExpires: string;
  absoluteExpires: string;
  ended: string | null;
  endReason: string | null;
}

/** Identity's server-side sessions (`app.UserSessions`) and the copied password (QC-616). */
export const identitySessions = {
  subjectFor(email: string): string {
    const id = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`);
    if (!id) throw new Error('The account is not in Identity.');
    return id;
  },

  hostPasswordHashMatches(email: string, hostDatabase: string): boolean {
    const value = queryIdentityDb(
      `SELECT CASE WHEN i.PasswordHash IS NOT NULL AND i.PasswordHash = h.PasswordHash THEN 1 ELSE 0 END FROM auth.Users i ` +
        `JOIN [${hostDatabase}].auth.Users h ON h.UserUUID = i.UserUUID WHERE i.NormalizedEmail = UPPER(${sqlText(email)})`,
    );
    return value === '1';
  },

  lastId(): number {
    return Number(queryIdentityDb('SELECT ISNULL(MAX(UserSessionID), 0) FROM app.UserSessions'));
  },

  openSince(subject: string, afterId: number): IdentitySessionRow[] {
    return identitySessions.rows(`SubjectID = ${sqlText(subject)} AND UserSessionID > ${afterId} AND Ended IS NULL`);
  },

  rows(where: string): IdentitySessionRow[] {
    const output = queryIdentityDb(
      `SELECT CONCAT(UserSessionID, '|', CONVERT(varchar(30), IdleExpires, 126), '|', CONVERT(varchar(30), AbsoluteExpires, 126), '|', ` +
        `ISNULL(CONVERT(varchar(30), Ended, 126), ''), '|', ISNULL(EndReason, '')) FROM app.UserSessions WHERE ${where} ORDER BY UserSessionID`,
    );
    if (!output) return [];
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, idleExpires, absoluteExpires, ended, endReason] = line.split('|');
        return { id: Number(id), idleExpires, absoluteExpires, ended: ended || null, endReason: endReason || null };
      });
  },

  /** Puts IdleExpires of the given open sessions of one subject in the past; returns the rows changed. */
  expireIdle(subject: string, ids: number[]): number {
    return Number(
      queryIdentityDb(
        `UPDATE app.UserSessions SET IdleExpires = DATEADD(hour, -12, GETUTCDATE()) ` +
          `WHERE SubjectID = ${sqlText(subject)} AND Ended IS NULL AND UserSessionID IN (${ids.join(',')}); SELECT @@ROWCOUNT`,
      ),
    );
  },
};

/** Host sessions linked to Identity sessions (`app.IdentitySessions` in the host database) that are still active for a user. */
export function activeHostSessions(userId: string): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.IdentitySessions WHERE UserID_FK = N'${userId.replace(/'/g, "''")}' AND Active = 1`));
}
