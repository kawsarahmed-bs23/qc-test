import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { BasePage } from '@pages/base.page';
import { ConfirmDialog, openAdmin, waitForIdle } from '@pages/admin-shell.page';
import { AppUserSession, AdminUserEditPage, VendorUserEditPage } from '@pages/user-eula.page';
import { EMAIL_EDITABLE_HINT, EMAIL_LOCKED_MESSAGE } from '@api/email-change.api';
import type { ThrowawayUser } from '@utils/throwawayUsers';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The Email (user name) field of a host-app user edit page, Admin > Users or Vendor > Users (QC-905). */
export class HostUserEmailField {
  readonly input: Locator;
  readonly hint: Locator;
  readonly error: Locator;
  readonly save: Locator;
  readonly successToast: Locator;

  constructor(private readonly page: Page) {
    const email = page.getByRole('textbox', { name: 'Email', exact: true });
    const field = page.locator('mat-form-field').filter({ has: email });
    this.input = field.getByRole('textbox', { name: 'Email', exact: true });
    this.hint = field.locator('mat-hint');
    this.error = field.locator('mat-error');
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.successToast = page.locator('.success-snackbar');
  }

  async expectLocked(email: string): Promise<void> {
    await expect(this.input).toHaveValue(email);
    await expect(this.input).toHaveAttribute('readonly', /.*/);
    await expect(this.input).not.toBeEditable();
    await expect(this.hint).toHaveText(EMAIL_LOCKED_MESSAGE);
  }

  async expectEditable(email: string): Promise<void> {
    await expect(this.input).toHaveValue(email);
    await expect(this.input).not.toHaveAttribute('readonly', /.*/);
    await expect(this.input).toBeEditable();
    await expect(this.hint).toHaveText(EMAIL_EDITABLE_HINT);
  }

  /** Types a new email and presses Save; returns the status of the user-edit POST. */
  async changeAndSave(email: string): Promise<number> {
    await this.input.fill(email);
    const saved = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/user-edit$/i.test(new URL(r.url()).pathname));
    await this.save.click();
    return (await saved).status();
  }

  async expectSaved(): Promise<void> {
    await expect(this.successToast.filter({ hasText: 'User updated successfully!' })).toBeVisible();
  }
}

/** My Profile (`#/my-profile`) in the host app. */
export class HostMyProfilePage extends BasePage {
  protected readonly path = '/#/my-profile';
  readonly emailNote: Locator;

  constructor(page: Page) {
    super(page);
    this.emailNote = page.getByTestId('profile-email-note');
  }

  async open(): Promise<void> {
    await this.page.goto(this.path);
    await expect(this.page.getByRole('heading', { name: 'Profile Information' })).toBeVisible({ timeout: 30_000 });
  }

  async expectEmailNote(email: string): Promise<void> {
    await expect(this.emailNote).toHaveText(EMAIL_LOCKED_MESSAGE);
    await expect(this.page.locator('dd').filter({ has: this.emailNote })).toContainText(email);
  }
}

/** A throwaway user's own host-app browser context with the pages QC-905 checks. */
export class EmailLockSession {
  readonly adminUserEdit: AdminUserEditPage;
  readonly vendorUserEdit: VendorUserEditPage;
  readonly emailField: HostUserEmailField;
  readonly myProfile: HostMyProfilePage;

  private constructor(readonly session: AppUserSession) {
    this.adminUserEdit = session.adminUserEdit;
    this.vendorUserEdit = session.vendorUserEdit;
    this.emailField = new HostUserEmailField(session.page);
    this.myProfile = new HostMyProfilePage(session.page);
  }

  get page(): Page {
    return this.session.page;
  }

  static async signIn(browser: Browser, user: ThrowawayUser): Promise<EmailLockSession> {
    const session = await AppUserSession.signIn(browser, user);
    await session.expectSignedIn();
    return new EmailLockSession(session);
  }

  close(): Promise<void> {
    return this.session.close();
  }
}

/** Identity's `/Account/ConfirmEmailChange?t=` page, opened from the link Identity emails to the new address. */
export class ConfirmEmailChangePage extends BasePage {
  protected readonly path = '/Account/ConfirmEmailChange';
  readonly question: Locator;
  readonly submit: Locator;
  readonly done: Locator;
  readonly invalid: Locator;
  readonly taken: Locator;

  constructor(page: Page) {
    super(page);
    this.question = page.locator('#confirm-email-question');
    this.submit = page.locator('#confirm-email-submit');
    this.done = page.locator('#confirm-email-done');
    this.invalid = page.locator('#confirm-email-invalid');
    this.taken = page.locator('#confirm-email-taken');
  }

  async open(link: string): Promise<void> {
    expect(link.startsWith(`${env.identityUrl}${this.path}?t=`), 'the link points at Identity').toBe(true);
    await this.page.goto(link);
  }

  async expectQuestion(newEmail: string): Promise<void> {
    await expect(this.question).toHaveText(`Make ${newEmail} your QuarryConnect login email?`);
    await expect(this.submit).toBeVisible();
  }

  async confirm(): Promise<void> {
    const posted = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/Account\/ConfirmEmailChange$/i.test(new URL(r.url()).pathname));
    await this.submit.click();
    expect((await posted).status(), 'the confirm POST answers').toBe(200);
  }

  async expectDone(newEmail: string): Promise<void> {
    await expect(this.done).toHaveText(`Your login email is now ${newEmail}. Sign in with it from now on.`);
  }

  async expectInvalid(): Promise<void> {
    await expect(this.invalid).toContainText('This link is invalid or has expired. Contact support to send a new one.');
    await expect(this.submit).toHaveCount(0);
  }

  async expectTaken(): Promise<void> {
    await expect(this.taken).toContainText('That email is already used by another login. Contact support.');
  }
}

/** The login email card (`#email-zone`) on Admin's user detail page and its change-email dialog (QC-905). */
export class UserEmailChangePanel extends BasePage {
  protected readonly path = '/users';
  readonly zone: Locator;
  readonly changeButton: Locator;
  readonly cancelRequestButton: Locator;
  readonly pendingEmail: Locator;
  readonly email: Locator;
  readonly dialog: Locator;
  readonly current: Locator;
  readonly newEmail: Locator;
  readonly reference: Locator;
  readonly submit: Locator;
  readonly cancel: Locator;
  readonly error: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(page: Page) {
    super(page);
    this.zone = page.locator('#email-zone');
    this.changeButton = page.locator('#email-change');
    this.cancelRequestButton = page.locator('#email-change-cancel');
    this.pendingEmail = page.locator('#user-pending-email');
    this.email = page.locator('#user-email');
    this.dialog = page.getByTestId('change-email-dialog');
    this.current = this.dialog.locator('#change-email-current');
    this.newEmail = this.dialog.locator('input#change-email-new');
    this.reference = this.dialog.locator('input#change-email-reference');
    this.submit = this.dialog.locator('#change-email-submit');
    this.cancel = this.dialog.locator('#change-email-cancel');
    this.error = this.dialog.locator('#change-email-error');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async open(userId: string): Promise<void> {
    await openAdmin(this.page, `${this.path}/${userId}`);
    await expect(this.zone).toBeVisible({ timeout: 30_000 });
    await waitForIdle(this.page);
  }

  async openDialog(currentEmail: string): Promise<void> {
    await this.changeButton.click();
    await expect(this.dialog).toBeVisible();
    await expect(this.current).toHaveText(currentEmail);
  }

  async fill(newEmail: string, reference: string): Promise<void> {
    await this.newEmail.fill(newEmail);
    await this.reference.fill(reference);
  }

  /** Presses Send confirmation and returns the status of the Admin API call. */
  async send(): Promise<number> {
    const posted = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/users\/[^/]+\/email$/i.test(new URL(r.url()).pathname));
    await this.submit.click();
    return (await posted).status();
  }

  /** The mat-error under a dialog field, by the field's input id (`change-email-new`, `change-email-reference`). */
  fieldError(inputId: 'change-email-new' | 'change-email-reference'): Locator {
    return this.dialog
      .locator('mat-form-field')
      .filter({ has: this.page.locator(`input#${inputId}`) })
      .locator('mat-error');
  }

  async expectPending(newEmail: string): Promise<void> {
    await expect(this.pendingEmail).toContainText(new RegExp(`^\\s*Waiting for ${escapeRegExp(newEmail)} to confirm \\(link expires .+\\)\\s*$`));
    await expect(this.cancelRequestButton).toBeVisible();
  }

  async expectNoPending(): Promise<void> {
    await expect(this.pendingEmail).toHaveCount(0);
    await expect(this.cancelRequestButton).toHaveCount(0);
  }

  async cancelRequest(pendingEmail: string, currentEmail: string): Promise<void> {
    await this.cancelRequestButton.click();
    await expect(this.confirmDialog.title).toHaveText('Cancel email change?');
    await expect(this.confirmDialog.message).toHaveText(`The confirmation link sent to ${pendingEmail} stops working. ${currentEmail} stays the login.`);
    const canceled = this.page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/api\/users\/[^/]+\/email$/i.test(new URL(r.url()).pathname));
    await this.confirmDialog.accept();
    expect((await canceled).status(), 'the cancel request answers').toBe(200);
  }
}
