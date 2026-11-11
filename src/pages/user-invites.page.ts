import * as fs from 'fs';
import * as path from 'path';
import { devices, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { BasePage } from '@pages/base.page';
import { IdentityInvitePage } from '@pages/identity-invite.page';
import { IdentityLoginPage } from '@pages/identity-login.page';
import { AppUserSession } from '@pages/user-eula.page';
import type { InviteStatus } from '@api/user-invites.api';
import type { ThrowawayUser } from '@utils/throwawayUsers';

const BADGE_LABELS: Record<InviteStatus, string> = {
  'not-invited': 'Not invited',
  invited: 'Invited',
  expired: 'Expired',
  declined: 'Declined',
  linked: 'Linked',
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Sign-in section of Edit User and Vendor My Users (QC-913): invite badge, dates and Send/Resend invite. */
export class UserInviteSection {
  readonly section: Locator;
  readonly status: Locator;
  readonly badge: Locator;
  readonly send: Locator;
  readonly sentAt: Locator;
  readonly expiresAt: Locator;
  readonly declinedAt: Locator;
  readonly toast: Locator;
  readonly errorToast: Locator;

  constructor(private readonly page: Page) {
    this.section = page.locator('#user-signin-section');
    this.status = page.locator('#user-invite-status');
    this.badge = this.status.locator('[data-status]');
    this.send = page.locator('#user-invite-send');
    this.sentAt = page.locator('#user-invite-sent-at');
    this.expiresAt = page.locator('#user-invite-expires-at');
    this.declinedAt = page.locator('#user-invite-declined-at');
    this.toast = page.locator('.success-snackbar');
    this.errorToast = page.locator('.error-snackbar');
  }

  async expectStatus(status: InviteStatus): Promise<void> {
    await expect(this.badge).toHaveAttribute('data-status', status);
    await expect(this.badge).toHaveText(BADGE_LABELS[status]);
  }

  /** Invited/Expired show "Sent <date>" and "Expires <date>" in the API's MM/dd/yyyy hh:mmtt display format. */
  async expectSentAndExpires(): Promise<void> {
    await expect(this.sentAt).toHaveText(/^Sent \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/);
    await expect(this.expiresAt).toHaveText(/^Expires \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/);
    await expect(this.declinedAt).toHaveCount(0);
  }

  async expectSendButton(label: 'Send invite' | 'Resend invite'): Promise<void> {
    await expect(this.send).toBeVisible();
    await expect(this.send).toBeEnabled();
    await expect(this.send).toHaveText(label);
  }

  async expectNoSendButton(): Promise<void> {
    await expect(this.send).toHaveCount(0);
  }

  /** Presses Send/Resend invite and returns the status and body of the POST .../user-edit/{id}/invite. */
  async sendInvite(): Promise<{ status: number; text: string }> {
    const posted = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-edit\/[^/]+\/invite$/i.test(new URL(r.url()).pathname));
    await this.send.click();
    const response = await posted;
    return { status: response.status(), text: await response.text() };
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.toast.filter({ hasText: text })).toBeVisible();
  }
}

/** Create/Edit User of Manage Users (`#/admin/user`) and Vendor My Users (`#/vendors/vendor-user`). */
abstract class HostUserFormPage extends BasePage {
  readonly email: Locator;
  readonly firstName: Locator;
  readonly lastName: Locator;
  readonly passwordInputs: Locator;
  readonly passwordLabels: Locator;
  readonly createHint: Locator;
  readonly save: Locator;
  readonly toast: Locator;
  readonly signIn: UserInviteSection;

  constructor(page: Page) {
    super(page);
    this.email = page.getByLabel('Email', { exact: true });
    this.firstName = page.getByLabel('First Name', { exact: true });
    this.lastName = page.getByLabel('Last Name', { exact: true });
    this.passwordInputs = page.locator('form input[type="password"]');
    this.passwordLabels = page.locator('form mat-label').filter({ hasText: /password/i });
    this.createHint = page.locator('#user-signin-section').getByText('Save the user, then send the invite from here.');
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.toast = page.locator('.success-snackbar');
    this.signIn = new UserInviteSection(page);
  }

  /** Opens the page with a full reload, so a different user id never reuses the component the previous one loaded. */
  async open(userId?: string): Promise<void> {
    await this.page.goto(userId ? `${this.path}/${encodeURIComponent(userId)}` : this.path);
    await this.page.reload();
    await expect(this.page.getByRole('heading', { name: userId ? 'Edit User' : 'Create New User', exact: true }).first()).toBeVisible({ timeout: 30_000 });
    if (userId) await expect(this.email).not.toHaveValue('', { timeout: 15_000 });
  }

  async expectNoPasswordFields(): Promise<void> {
    await expect(this.email).toBeVisible();
    await expect(this.passwordInputs).toHaveCount(0);
    await expect(this.passwordLabels).toHaveCount(0);
    await expect(this.page.getByText('User can change their own password')).toHaveCount(0);
  }

  async fillPerson(email: string, firstName: string, lastName: string): Promise<void> {
    await this.email.fill(email);
    await this.firstName.fill(firstName);
    await this.lastName.fill(lastName);
  }

  /** Presses Save on the create page; returns the new user's id from the user-create answer once the app shows its edit page. */
  async saveNew(): Promise<string> {
    const created = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-create$/i.test(new URL(r.url()).pathname));
    await this.save.click();
    const response = await created;
    const body = (await response.json().catch(() => null)) as { data?: unknown } | null;
    expect(response.status(), `user-create answered ${JSON.stringify(body)}`).toBe(201);
    const userId = typeof body?.data === 'string' ? body.data : '';
    expect(userId, 'user-create answers the new user id').not.toBe('');
    await expect(this.page).toHaveURL(new RegExp(`#${escapeRegExp(this.path.replace(/^\/#/, ''))}/${escapeRegExp(userId)}$`, 'i'), { timeout: 15_000 });
    await expect(this.page.getByRole('heading', { name: 'Edit User', exact: true }).first()).toBeVisible();
    return userId;
  }

  /** Presses Save on the edit page and returns the status of the user-edit POST. */
  async saveExisting(): Promise<number> {
    const saved = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-edit$/i.test(new URL(r.url()).pathname));
    await this.save.click();
    return (await saved).status();
  }

  async expectToast(text: string): Promise<void> {
    await expect(this.toast.filter({ hasText: text })).toBeVisible();
  }
}

export class AdminUserFormPage extends HostUserFormPage {
  protected readonly path = '/#/admin/user';
  readonly role: Locator;

  constructor(page: Page) {
    super(page);
    this.role = page.getByRole('combobox', { name: 'Role' });
  }

  async chooseRole(name: string): Promise<void> {
    await this.role.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.role).toContainText(name);
  }
}

export class VendorUserFormPage extends HostUserFormPage {
  protected readonly path = '/#/vendors/vendor-user';
  readonly truckDriver: Locator;
  readonly truck: Locator;

  constructor(page: Page) {
    super(page);
    this.truckDriver = page.getByRole('checkbox', { name: 'Truck Driver' });
    this.truck = page.getByRole('combobox', { name: 'Truck' });
  }

  async chooseTruck(name: string): Promise<void> {
    await this.truckDriver.check();
    await this.truck.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.truck).toContainText(name);
  }
}

/** The Sign-in column of the Manage Users list (`#/admin/users`) and the Vendor users list (`#/vendors/vendor-users`). */
export class UserListSignInColumn {
  readonly search: Locator;
  readonly header: Locator;

  constructor(private readonly page: Page) {
    this.search = page.getByPlaceholder('Search Anything');
    this.header = page.getByRole('columnheader', { name: 'Sign-in', exact: true });
  }

  async open(list: 'admin' | 'vendor'): Promise<void> {
    await this.page.goto(list === 'admin' ? '/#/admin/users' : '/#/vendors/vendor-users');
    await expect(this.search).toBeVisible({ timeout: 30_000 });
    await expect(this.header).toBeVisible();
  }

  /** The row of a user, found through the list's own search box. Material's row class is the only hook the table offers. */
  async row(email: string): Promise<Locator> {
    const searched = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-search$/i.test(new URL(r.url()).pathname));
    await this.search.fill(email);
    await this.search.press('Enter');
    await searched;
    const row = this.page.locator('tr.mat-mdc-row').filter({ hasText: email });
    await expect(row).toHaveCount(1);
    return row;
  }

  async expectBadge(email: string, status: InviteStatus): Promise<void> {
    const badge = (await this.row(email)).locator('td.mat-column-invite [data-status]');
    await expect(badge).toHaveAttribute('data-status', status);
    await expect(badge).toHaveText(BADGE_LABELS[status]);
  }
}

/** The vendor sidebar: QC-913 removed the Driver Invites page and its menu link. */
export class VendorSidebar {
  readonly driverInvites: Locator;
  readonly manageUsers: Locator;

  constructor(page: Page) {
    this.driverInvites = page.locator('a[href*="vendor-driver-invites"]');
    this.manageUsers = page.locator('a.sidebar-menu-link').filter({ hasText: 'Manage Users' });
  }
}

export interface InviteOutcome {
  status: string | null;
  url: string;
}

/**
 * The invited person's own signed-out browser: opens the emailed links on Identity, lets the real host answer the return
 * address, and lands on Identity's /invite/complete page.
 */
export class InviteeBrowser {
  readonly invite: IdentityInvitePage;
  readonly login: IdentityLoginPage;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.invite = new IdentityInvitePage(page);
    this.login = new IdentityLoginPage(page);
  }

  static async open(browser: Browser): Promise<InviteeBrowser> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: [], origins: [] },
    });
    return new InviteeBrowser(context, await context.newPage());
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url);
  }

  private async completed(): Promise<InviteOutcome> {
    await this.page.waitForURL((url) => url.href.startsWith(`${env.identityUrl}/invite/complete`), { timeout: 30_000 });
    return { status: new URL(this.page.url()).searchParams.get('status'), url: this.page.url() };
  }

  /** New login: the setup form for the invited email and names, password, Terms, Save Settings. */
  async acceptAsNew(acceptUrl: string, person: { email: string; firstName: string; lastName: string; password: string }): Promise<InviteOutcome> {
    await this.goto(acceptUrl);
    await this.invite.expectSetupFor(person.email, person.firstName, person.lastName);
    await this.invite.saveSettings({ password: person.password, acceptTerms: true });
    return this.completed();
  }

  /** Existing login: "Sign in to connect with {Host}", Identity sign-in, then Accept invite. */
  async acceptAsExisting(acceptUrl: string, login: Credentials): Promise<InviteOutcome> {
    await this.goto(acceptUrl);
    const hostName = await this.invite.hostDisplayName();
    await this.invite.expectExistingLogin(login.email, hostName);
    await this.invite.signInToConnect.click();
    await this.login.expectVisible();
    await expect(this.login.email).toHaveValue(login.email);
    await this.login.signIn(login);
    await expect(this.invite.acceptForm).toBeVisible({ timeout: 30_000 });
    await expect(this.invite.acceptQuestion).toHaveText(`Connect ${login.email} to ${hostName}?`);
    await this.invite.acceptConfirm.click();
    return this.completed();
  }

  /** The email's decline link: "Decline the invite from {Host}?", Decline. */
  async decline(declineUrl: string): Promise<InviteOutcome & { hostName: string }> {
    await this.goto(declineUrl);
    await expect(this.invite.declineConfirm).toBeVisible({ timeout: 30_000 });
    const heading = (await this.invite.pageHeading.innerText()).trim();
    const hostName = heading.replace(/^Decline the invite from /, '').replace(/\?$/, '');
    await this.invite.expectDeclineQuestion(hostName);
    await this.invite.declineConfirm.click();
    return { ...(await this.completed()), hostName };
  }

  /** Signs in to the host app at APP_URL with a login that has no two-step verification, and waits for the app token. */
  async signInToHostApp(login: Credentials): Promise<void> {
    await this.page.goto('/');
    await this.login.signIn(login);
    await this.page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
    await expect
      .poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { message: 'the host app holds an access token', timeout: 30_000 })
      .toBeTruthy();
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

/** Signs a throwaway host user in to the host app through Identity (two-step) and keeps the session in `statePath`. */
export async function saveHostAppSession(browser: Browser, user: ThrowawayUser, statePath: string): Promise<void> {
  const session = await AppUserSession.signIn(browser, user);
  try {
    await session.expectSignedIn();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await session.context.storageState({ path: statePath });
  } finally {
    await session.close();
  }
}

/** A throwaway vendor's own host-app session (Identity sign-in with two-step), with the Vendor Portal pages. */
export class VendorPortalSession {
  readonly form: VendorUserFormPage;
  readonly list: UserListSignInColumn;
  readonly sidebar: VendorSidebar;

  private constructor(private readonly session: AppUserSession) {
    this.form = new VendorUserFormPage(session.page);
    this.list = new UserListSignInColumn(session.page);
    this.sidebar = new VendorSidebar(session.page);
  }

  get page(): Page {
    return this.session.page;
  }

  static async signIn(browser: Browser, vendor: ThrowawayUser): Promise<VendorPortalSession> {
    const session = await AppUserSession.signIn(browser, vendor);
    await session.expectSignedIn();
    return new VendorPortalSession(session);
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
