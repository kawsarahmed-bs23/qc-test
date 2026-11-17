import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from '@pages/base.page';
import { adminUrl, openAdmin } from '@pages/admin-shell.page';
import { AdminUserFormPage } from '@pages/user-invites.page';
import type { InviteStatus } from '@api/user-invites.api';

export const STATUS_WORDS: Record<InviteStatus, string> = {
  'not-invited': 'No Email Invite Sent',
  invited: 'Email Invite Sent',
  expired: 'Email Invite Expired',
  declined: 'Declined',
  linked: 'Active',
};

export const OLD_STATUS_WORDS = ['Not invited', 'Invited', 'Expired', 'Linked'];

export const EMAIL_HINT = 'Email is the username and cannot be changed once user has Signed-In first time';
export const PHONE_HINT = 'Optional, 10-digit US number. Needed for text messages.';
export const NOT_SET_UP_MESSAGE = "Invites aren't available for this account yet. Please contact support.";

/** Create New User and Edit User of Manage Users (QC-983): blank role, card order, centred buttons and the Sign-In History card. */
export class UserRefinementsFormPage extends AdminUserFormPage {
  readonly roleField: Locator;
  readonly roleError: Locator;
  readonly organisation: Locator;
  readonly cancel: Locator;
  readonly cards: Locator;
  readonly buttonCard: Locator;
  readonly historyCard: Locator;
  readonly historyHeading: Locator;
  readonly eula: Locator;
  readonly oldSignInHeading: Locator;
  readonly createRequests: string[] = [];

  constructor(private readonly formPage: Page) {
    super(formPage);
    this.roleField = formPage.locator('app-form-field').filter({ has: formPage.getByRole('combobox', { name: 'Role' }) });
    this.roleError = this.roleField.locator('mat-error');
    this.organisation = formPage.getByRole('combobox', { name: 'Organisation' });
    this.cancel = formPage.getByRole('button', { name: 'Cancel', exact: true });
    this.cards = formPage.locator('form > mat-card');
    this.buttonCard = formPage.locator('form > mat-card.btn-box');
    this.historyCard = formPage.locator('#user-signin-history');
    this.historyHeading = this.historyCard.getByRole('heading', { name: 'Sign-In History', exact: true });
    this.eula = formPage.locator('#eula-status');
    this.oldSignInHeading = formPage.locator('#user-signin-section').getByRole('heading', { name: 'Sign-in', exact: true });
  }

  watchCreates(): void {
    this.formPage.on('request', (request) => {
      if (request.method() === 'POST' && /\/user-create$/i.test(new URL(request.url()).pathname)) this.createRequests.push(request.url());
    });
  }

  async expectRoleBlank(): Promise<void> {
    await expect(this.role).toBeVisible();
    await expect(this.role).not.toContainText(/Admin|Accounting|Sales|Customer|Vendor|Driver/);
  }

  async expectOrganisationEmpty(): Promise<void> {
    await expect(this.formPage.getByRole('option')).toHaveCount(0);
    const field = this.formPage.locator('app-form-field').filter({ has: this.formPage.getByLabel('Organisation') });
    await expect(field).not.toContainText(/E2E|Stella|Rock Ridge/);
  }

  async expectRoleRequiredError(): Promise<void> {
    await expect(this.roleError.first()).toContainText(/required/i);
  }

  async expectCardOrder(): Promise<void> {
    await expect(this.cards).toHaveCount(3);
    await expect(this.cards.nth(1)).toHaveClass(/btn-box/);
    await expect(this.cards.nth(2)).toHaveAttribute('id', 'user-signin-history');
    await expect(this.cards.nth(0).getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  }

  async expectButtonsCentred(): Promise<void> {
    const content = this.buttonCard.locator('mat-card-content');
    await expect(content).toHaveCSS('justify-content', 'center');
    const box = await content.boundingBox();
    const save = await this.save.boundingBox();
    const cancel = await this.cancel.boundingBox();
    expect(box && save && cancel, 'the buttons and their card are visible').toBeTruthy();
    const mid = box!.x + box!.width / 2;
    const left = save!.x;
    const right = cancel!.x + cancel!.width;
    expect(Math.abs((left + right) / 2 - mid), 'Save and Cancel sit in the middle of their card').toBeLessThan(8);
  }

  async expectSendIsPrimary(): Promise<void> {
    await expect(this.signIn.send).toHaveClass(/mat-mdc-unelevated-button/);
    await expect(this.signIn.send).toHaveClass(/daxa/);
    await expect(this.signIn.send).not.toHaveClass(/mat-mdc-outlined-button/);
  }

  async expectEulaInHistory(): Promise<void> {
    await expect(this.historyCard.locator('#eula-status')).toBeVisible();
    await expect(this.cards.nth(0).locator('#eula-status')).toHaveCount(0);
    await expect(this.historyCard.locator('#user-invite-status')).toBeVisible();
    await expect(this.historyCard.locator('#user-invite-send')).toBeVisible();
    await expect(this.oldSignInHeading).toHaveCount(0);
  }

  hint(text: string): Locator {
    return this.formPage.locator('mat-hint, .mat-mdc-form-field-hint-wrapper').filter({ hasText: text }).first();
  }

  async expectHints(): Promise<void> {
    await expect(this.hint(EMAIL_HINT)).toBeVisible();
    await expect(this.hint(PHONE_HINT)).toBeVisible();
  }

  async expectStatusWording(status: InviteStatus): Promise<void> {
    await expect(this.signIn.badge).toHaveAttribute('data-status', status);
    await expect(this.signIn.badge).toHaveText(STATUS_WORDS[status]);
  }
}

/** The Manage Users list (`#/admin/users`) after QC-983: Status and Roles columns, Company, and the Role and Company filters. */
export class HostUsersListPage extends BasePage {
  protected readonly path = '/#/admin/users';
  readonly search: Locator;
  readonly roleFilter: Locator;
  readonly companyFilter: Locator;
  readonly headers: Locator;
  readonly rows: Locator;

  constructor(private readonly listPage: Page) {
    super(listPage);
    this.search = listPage.getByPlaceholder('Search Anything');
    this.roleFilter = listPage.locator('#users-filter-role');
    this.companyFilter = listPage.locator('#users-filter-company');
    this.headers = listPage.locator('tr.mat-mdc-header-row th');
    this.rows = listPage.locator('tr.mat-mdc-row');
  }

  async open(): Promise<void> {
    await this.listPage.goto(this.path);
    await expect(this.search).toBeVisible({ timeout: 30_000 });
    await expect(this.headers.first()).toBeVisible();
  }

  private listed(): Promise<unknown> {
    return this.listPage.waitForResponse((r) => r.request().method() === 'POST' && /\/user-search$/i.test(new URL(r.url()).pathname));
  }

  async searchFor(text: string): Promise<void> {
    const searched = this.listed();
    await this.search.fill(text);
    await this.search.press('Enter');
    await searched;
  }

  row(email: string): Locator {
    return this.rows.filter({ hasText: email });
  }

  badges(email: string): Locator {
    return this.row(email).locator('[data-testid="user-role-badge"]');
  }

  statusBadge(email: string): Locator {
    return this.row(email).locator('td.mat-column-invite [data-status]');
  }

  company(email: string): Locator {
    return this.row(email).locator('td.mat-column-organisationName');
  }

  async headerTexts(): Promise<string[]> {
    return (await this.headers.allInnerTexts()).map((t) => t.trim());
  }

  async chooseRole(name: string): Promise<void> {
    await this.roleFilter.click();
    const searched = this.listed();
    await this.listPage.getByRole('option', { name, exact: true }).click();
    await searched;
  }

  async chooseCompany(name: string): Promise<void> {
    await this.companyFilter.click();
    const searched = this.listed();
    await this.listPage.getByRole('option', { name, exact: true }).click();
    await searched;
  }

  async companyOptions(): Promise<string[]> {
    await this.companyFilter.click();
    const options = (await this.listPage.getByRole('option').allInnerTexts()).map((t) => t.trim());
    await this.listPage.keyboard.press('Escape');
    return options;
  }
}

/** Host detail of the Admin app: Test connection and its two result lines (QC-983 adds the invites line). */
export class HostInviteLinePage extends BasePage {
  protected readonly path = '/hosts';
  readonly testConnection: Locator;
  readonly connectionResult: Locator;
  readonly inviteResult: Locator;
  readonly inviteResultUnderConnection: Locator;
  readonly signInMode: Locator;

  constructor(private readonly adminPage: Page) {
    super(adminPage);
    this.testConnection = adminPage.locator('#host-test-connection');
    this.connectionResult = adminPage.locator('#host-connection-result');
    this.inviteResult = adminPage.locator('#host-invite-result');
    this.inviteResultUnderConnection = adminPage.locator('#host-connection-result + #host-invite-result');
    this.signInMode = adminPage.locator('#host-sign-in-mode');
  }

  async open(hostUuid: string): Promise<void> {
    await openAdmin(this.adminPage, `/hosts/${hostUuid}`);
    await expect(this.testConnection).toBeVisible({ timeout: 30_000 });
  }

  url(hostUuid: string): string {
    return adminUrl(`/hosts/${hostUuid}`);
  }

  async runTest(): Promise<void> {
    await this.testConnection.click();
    await expect(this.connectionResult).toBeVisible({ timeout: 30_000 });
  }
}
