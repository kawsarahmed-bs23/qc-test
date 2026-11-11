import * as crypto from 'crypto';
import { devices, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { BasePage } from '@pages/base.page';
import { formatAppDateTime } from '@pages/app.page';
import { IdentityLoginPage } from '@pages/identity-login.page';
import { AppSignInErrorView } from '@pages/sign-in-redirect.page';
import { querySingleValue, queryIdentityDb, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';

export const QC888_EMAIL_LIKE = 'e2e.qc888.%@quarryconnect.test';
export const EULA_REJECTED_SIGN_IN = 'User EULA was rejected. Please contact the Administrator.';
export const EULA_RESET_MESSAGE = 'EULA reset. The user will be asked to accept it at their next login.';
export const EULA_NOT_REJECTED_MESSAGE = 'User has not rejected the EULA.';
export const EULA_ROUTE = '/legal/sign-user-agreement';

export const HOST_ORGANISATION_ID = 30;
export const VENDOR_ORGANISATION_ID = 34;
export const VENDOR_TRUCK_ORGANISATION_ID = 38;

export type EulaSeed = 'rejected' | 'accepted' | 'none';
export type HostRole = 'Admin' | 'Vendor' | 'Driver';

export interface Qc888User {
  email: string;
  userId: string;
  eulaOnUtc: Date;
  signIn: ThrowawayUser | null;
}

export function qc888Email(name: string): string {
  return `e2e.qc888.${name}@quarryconnect.test`;
}

function sqlUtc(instant: Date): string {
  return instant.toISOString().slice(0, 19).replace('T', ' ');
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Seeds one e2e.qc888.* host user. With `canSignIn` it also seeds the Identity user (two-step on, the password of
 * ADMIN_EMAIL) and gives the host user the same id, since Identity's sub is the host auth.Users.Id.
 */
export function seedQc888User(options: {
  name: string;
  role: HostRole;
  organisationId: number;
  eula: EulaSeed;
  eulaOnUtc?: Date;
  canSignIn?: boolean;
}): Qc888User {
  const email = qc888Email(options.name);
  const eulaOnUtc = options.eulaOnUtc ?? new Date(Date.UTC(2026, 9, 1, 15, 30, 0));
  let signIn: ThrowawayUser | null = null;
  let userId: string = crypto.randomUUID();

  if (options.canSignIn) {
    if (!env.admin) {
      throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
    }
    const authenticatorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc888-user.apply.sql', {
      Email: email,
      SourceEmail: env.admin.email,
      LastName: `QC-888 ${options.role}`,
      TwoFactor: '1',
      AuthenticatorKey: authenticatorKey,
    });
    const identityId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${sqlText(email)}')`);
    if (!identityId) {
      throw new Error(`The throwaway Identity user ${email} was not created.`);
    }
    userId = identityId;
    signIn = { email, password: env.admin.password, userId, authenticatorKey };
  }

  runSeedScript('host-qc888-user.apply.sql', {
    UserId: userId,
    Email: email,
    Role: options.role,
    OrganisationId: String(options.organisationId),
    Eula: options.eula,
    EulaOnUtc: sqlUtc(eulaOnUtc),
  });
  return { email, userId, eulaOnUtc, signIn };
}

export function removeQc888Users(): void {
  runSeedScript('host-qc888.remove.sql');
  runIdentitySeedScript('identity-qc888.remove.sql', { EmailLike: QC888_EMAIL_LIKE });
}

export function remainingQc888Rows(): number {
  return Number(
    querySingleValue(
      `SELECT (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC888.%')` +
        ` + (SELECT COUNT(*) FROM auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC888.%'))`,
    ),
  );
}

export interface EulaDbState {
  rejected: boolean;
  rejectedOn: string | null;
  signatures: number;
  audits: number;
}

export function eulaDbState(userId: string): EulaDbState {
  const id = sqlText(userId);
  return {
    rejected: querySingleValue(`SELECT CAST(RejectedEULA AS int) FROM auth.Users WHERE Id = N'${id}'`) === '1',
    rejectedOn: querySingleValue(`SELECT CONVERT(varchar(19), RejectedEULAOn, 120) FROM auth.Users WHERE Id = N'${id}'`),
    signatures: Number(querySingleValue(`SELECT COUNT(*) FROM auth.UserSignedEULAs WHERE UserId = N'${id}'`)),
    audits: Number(querySingleValue(`SELECT COUNT(*) FROM auth.AuditChanges WHERE KeyId = '${id}' AND AuditAction = 'Update' AND AuditObject = 'User'`)),
  };
}

export function appDateTime(instant: Date): string {
  if (!env.appTimeZone) {
    throw new Error('APP_TIME_ZONE is not set.');
  }
  return formatAppDateTime(instant, env.appTimeZone);
}

/**
 * Opens the host app signed out and gets to Identity's sign-in page: in Identity mode the app goes there by itself; in Both
 * mode (QC-956) it shows its own password form with "Sign in with QuarryConnect", which is pressed.
 */
export async function openIdentitySignInFromApp(page: Page): Promise<void> {
  await page.goto('/');
  const offered = page.getByRole('button', { name: 'Sign in with QuarryConnect' });
  const atIdentity = () => page.url().startsWith(env.identityUrl);
  await expect.poll(async () => atIdentity() || (await offered.isVisible()), { message: 'the app opens Identity or offers it', timeout: 30_000 }).toBe(true);
  if (!atIdentity()) await offered.click();
}

/** A seeded user's own browser context, signed in (or refused) through Identity, with the pages that user sees. */
export class AppUserSession {
  readonly agreement: SignUserAgreementPage;
  readonly signInError: AppSignInErrorView;
  readonly vendorUserEdit: VendorUserEditPage;
  readonly adminUserEdit: AdminUserEditPage;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.agreement = new SignUserAgreementPage(page);
    this.signInError = new AppSignInErrorView(page);
    this.vendorUserEdit = new VendorUserEditPage(page);
    this.adminUserEdit = new AdminUserEditPage(page);
  }

  /** Opens the app signed out, signs in at Identity with two-step verification and waits until the browser is back in the app. */
  static async signIn(browser: Browser, user: ThrowawayUser): Promise<AppUserSession> {
    const context = await newAppContext(browser);
    const page = await context.newPage();
    await openIdentitySignInFromApp(page);
    await new IdentityLoginPage(page).signInWithTwoStep(user, user.authenticatorKey!);
    await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
    return new AppUserSession(context, page);
  }

  async expectSignedIn(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }

  async expectRefused(message: string): Promise<void> {
    await this.signInError.expectVisible();
    await expect(this.signInError.message).toContainText(message);
    expect(await this.page.evaluate(() => localStorage.getItem('accessToken'))).toBeFalsy();
  }

  /** After Reject the user must be signed out: on Identity's sign-in or signed-out page, or the app's #/authentication, with no app token. */
  async expectSignedOutAfterReject(): Promise<void> {
    await expect
      .poll(() => this.page.url(), { timeout: 30_000, message: 'the app signs the user out after Reject' })
      .toMatch(new RegExp(`^(${escapeRegExp(env.identityUrl)}/Account/(Login|Logout|LoggedOut)|${escapeRegExp(env.appUrl ?? '')}/?#/authentication)`, 'i'));
    if (this.page.url().startsWith(env.appUrl ?? '')) {
      expect(await this.page.evaluate(() => localStorage.getItem('accessToken')), 'no access token is left after Reject').toBeFalsy();
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export async function newAppContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: env.appUrl ?? undefined,
    ignoreHTTPSErrors: env.ignoreHttpsErrors,
    userAgent: devices['Desktop Chrome'].userAgent,
    viewport: { width: 1440, height: 900 },
    storageState: { cookies: [], origins: [] },
  });
}

/** The EULA status row (`#eula-status`) and its Reset EULA action on a user edit page (QC-888). */
export class UserEulaStatus {
  readonly row: Locator;
  readonly resetButton: Locator;
  readonly dialog: Locator;
  readonly dialogConfirm: Locator;
  readonly successToast: Locator;

  constructor(private readonly page: Page) {
    this.row = page.locator('#eula-status');
    this.resetButton = page.locator('#reset-eula');
    this.dialog = page.getByRole('dialog');
    this.dialogConfirm = this.dialog.getByRole('button', { name: 'Reset EULA' });
    this.successToast = page.locator('.success-snackbar');
  }

  async expectRejected(on: string): Promise<void> {
    await expect(this.row).toHaveText(new RegExp(`^\\s*EULA:\\s*Rejected on ${escapeRegExp(on)}\\s*Reset EULA\\s*$`));
    await expect(this.resetButton).toBeVisible();
    await expect(this.resetButton).toBeEnabled();
  }

  async expectAccepted(on: string | RegExp): Promise<void> {
    const date = typeof on === 'string' ? escapeRegExp(on) : on.source;
    await expect(this.row).toHaveText(new RegExp(`^\\s*EULA:\\s*Accepted on ${date}\\s*$`));
    await expect(this.resetButton).toHaveCount(0);
  }

  async expectNotYetAccepted(): Promise<void> {
    await expect(this.row).toHaveText(/^\s*EULA:\s*Not yet accepted\s*$/);
    await expect(this.resetButton).toHaveCount(0);
  }

  async expectAbsent(): Promise<void> {
    await expect(this.row).toHaveCount(0);
    await expect(this.resetButton).toHaveCount(0);
  }

  async startReset(): Promise<void> {
    await this.resetButton.click();
    await expect(this.dialog).toBeVisible();
  }

  async expectConfirmFor(userName: string): Promise<void> {
    await expect(this.dialog).toContainText('Reset EULA');
    await expect(this.dialog).toContainText(`Reset the EULA for ${userName}? They will be asked to accept it at their next login.`);
    await expect(this.dialogConfirm).toBeVisible();
    await expect(this.dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  }

  async confirmReset(): Promise<void> {
    const reset = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-edit\/[^/]+\/reset-eula$/.test(new URL(r.url()).pathname));
    await this.dialogConfirm.click();
    const response = await reset;
    expect(response.status(), 'reset-eula response status').toBe(200);
    await expect(this.dialog).toHaveCount(0);
  }

  async expectSuccessToast(text: string): Promise<void> {
    await expect(this.successToast.filter({ hasText: text })).toBeVisible();
  }
}

abstract class UserEditPage extends BasePage {
  readonly eula: UserEulaStatus;

  constructor(page: Page) {
    super(page);
    this.eula = new UserEulaStatus(page);
  }

  /** Opens the page with a full reload, so a different user id never reuses the component the previous one loaded. */
  async open(userId?: string): Promise<void> {
    await this.page.goto(userId ? `${this.path}/${encodeURIComponent(userId)}` : this.path);
    await this.page.reload();
    await expect(this.page.getByRole('heading', { name: userId ? 'Edit User' : 'Create New User', exact: true }).first()).toBeVisible({ timeout: 30_000 });
  }
}

/** Admin > Users edit (`#/admin/user/<id>`) and create (`#/admin/user`). */
export class AdminUserEditPage extends UserEditPage {
  protected readonly path = '/#/admin/user';
}

/** Vendor > Users edit (`#/vendors/vendor-user/<id>`) and create (`#/vendors/vendor-user`). */
export class VendorUserEditPage extends UserEditPage {
  protected readonly path = '/#/vendors/vendor-user';
}

/** The end user agreement the host app shows after sign-in to a user who has not accepted the latest EULA. */
export class SignUserAgreementPage extends BasePage {
  protected readonly path = `/#${EULA_ROUTE}`;
  readonly root: Locator;
  readonly accept: Locator;
  readonly reject: Locator;

  constructor(page: Page) {
    super(page);
    this.root = page.locator('app-sign-user-agreement');
    this.accept = this.root.getByRole('button', { name: 'Accept' });
    this.reject = this.root.getByRole('button', { name: 'Reject' });
  }

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`#${escapeRegExp(EULA_ROUTE)}$`), { timeout: 30_000 });
    await expect(this.root.getByRole('heading', { name: 'End user legal agreement' })).toBeVisible({ timeout: 30_000 });
    await expect(this.accept).toBeEnabled();
  }

  async acceptAgreement(): Promise<void> {
    const signed = this.page.waitForResponse((r) => r.request().method() === 'POST' && /usersignedeula/i.test(new URL(r.url()).pathname));
    await this.accept.click();
    expect((await signed).ok(), 'the EULA accept request succeeds').toBe(true);
    await expect(this.page).not.toHaveURL(new RegExp(`#${escapeRegExp(EULA_ROUTE)}$`), { timeout: 30_000 });
  }

  /**
   * Presses Reject and waits for the API to answer. The app leaves for Identity's sign-out straight after, so the body is
   * gone; whether the server finished (flag, date and audit row) is checked in the database instead.
   */
  async rejectAgreement(): Promise<void> {
    const rejected = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/UserSignedEULAs\/Reject$/i.test(new URL(r.url()).pathname));
    await this.reject.click();
    expect((await rejected).ok(), 'the EULA reject request succeeds').toBe(true);
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
