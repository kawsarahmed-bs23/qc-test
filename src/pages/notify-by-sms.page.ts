import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { NotifyBySmsApi } from '@api/notify-by-sms.api';
import { AdminUserFormPage, VendorUserFormPage } from '@pages/user-invites.page';

export const TEXT_MESSAGES_LABEL = 'Text messages';
export const TEXT_MESSAGES_HELP = 'Texts Job offers and messages to this number.';
export const CONTACT_LOCKED_TEXT = 'Set by the Driver in the Driver App.';
export const CONTACT_PROPOSED_TEXT = 'Sent to the Driver to approve in the Driver App.';
export const TEXTS_ON_TEXT = 'Only the Driver can turn texts off, in the Driver App.';
export const PHONE_HINT = '10-digit US number';
export const ADMIN_USER_PHONE_HINT = 'Optional, 10-digit US number. Needed for text messages.';

/** The QC-936 "Text messages" tick with its help line, inside the block the app marks with an id. */
export class TextMessagesField {
  readonly root: Locator;
  readonly checkbox: Locator;

  constructor(root: Locator) {
    this.root = root;
    this.checkbox = root.getByRole('checkbox', { name: TEXT_MESSAGES_LABEL });
  }

  help(text: string): Locator {
    return this.root.getByText(text, { exact: true });
  }
}

/** The Phone Number field of the user form and its hint (Material's `mat-hint` is the only hook for the hint). */
export class PhoneField {
  readonly input: Locator;
  readonly hint: Locator;

  constructor(page: Page) {
    this.input = page.getByRole('textbox', { name: 'Phone Number' });
    this.hint = page.locator('mat-form-field').filter({ has: this.input }).locator('mat-hint');
  }
}

/** What both user forms show for a linked user while Drivers:Mode is Off (the way they behaved before QC-933): everything read-only. */
async function expectContactLocked(textMessages: TextMessagesField, phone: PhoneField): Promise<void> {
  await expect(textMessages.checkbox).toBeVisible();
  await expect(textMessages.checkbox).toBeDisabled();
  await expect(textMessages.help(CONTACT_LOCKED_TEXT)).toBeVisible();
  await expect(textMessages.help(TEXT_MESSAGES_HELP)).toHaveCount(0);
  await expect(phone.input).toHaveAttribute('readonly', /.*/);
  await expect(phone.input).not.toBeEditable();
  await expect(phone.hint).toHaveText(CONTACT_LOCKED_TEXT);
}

/** With Drivers:Mode On (`IsContactProposed`) the phone and Text messages can be edited and the change is sent to the Driver to approve. */
async function expectContactForDriverApproval(textMessages: TextMessagesField, phone: PhoneField): Promise<void> {
  await expect(textMessages.checkbox).toBeVisible();
  await expect(textMessages.checkbox).toBeEnabled();
  await expect(textMessages.help(CONTACT_PROPOSED_TEXT)).toBeVisible();
  await expect(textMessages.help(TEXT_MESSAGES_HELP)).toHaveCount(0);
  await expect(phone.input).toBeEditable();
  await expect(phone.hint).toHaveText(CONTACT_PROPOSED_TEXT);
}

/** With Drivers:Mode On and Text messages already on, only the Driver can turn them off. */
async function expectTextsOnlyDriverCanTurnOff(textMessages: TextMessagesField, phone: PhoneField): Promise<void> {
  await expect(textMessages.checkbox).toBeChecked();
  await expect(textMessages.checkbox).toBeDisabled();
  await expect(textMessages.help(TEXTS_ON_TEXT)).toBeVisible();
  await expect(phone.input).toBeEditable();
}

/** What both user forms show for a user the host still owns: the tick and the phone can be changed. */
async function expectContactEditable(textMessages: TextMessagesField, phone: PhoneField, phoneHint: string = PHONE_HINT): Promise<void> {
  await expect(textMessages.checkbox).toBeEnabled();
  await expect(textMessages.help(TEXT_MESSAGES_HELP)).toBeVisible();
  await expect(phone.input).toBeEditable();
  await expect(phone.hint).toHaveText(phoneHint);
}

/** Manage Users create / edit (`#/admin/user`): the "Text messages" tick under Phone Number (`#user-notify-by-sms`), shown for Vendor and Driver roles. */
export class AdminUserTextMessagesPage extends AdminUserFormPage {
  readonly textMessages: TextMessagesField;
  readonly phone: PhoneField;
  readonly organisation: Locator;
  readonly pendingChanges: Locator;

  constructor(page: Page) {
    super(page);
    this.textMessages = new TextMessagesField(page.locator('#user-notify-by-sms'));
    this.phone = new PhoneField(page);
    this.pendingChanges = page.getByTestId('pending-change');
    this.organisation = page.getByRole('combobox', { name: 'Organisation' });
  }

  async chooseOrganisation(name: string): Promise<void> {
    await this.organisation.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.organisation).toContainText(name);
  }

  async expectContactLocked(): Promise<void> {
    await expectContactLocked(this.textMessages, this.phone);
  }

  async expectContactForDriverApproval(): Promise<void> {
    await expectContactForDriverApproval(this.textMessages, this.phone);
  }

  async expectTextsOnlyDriverCanTurnOff(): Promise<void> {
    await expectTextsOnlyDriverCanTurnOff(this.textMessages, this.phone);
  }

  async expectContactEditable(): Promise<void> {
    await expectContactEditable(this.textMessages, this.phone, ADMIN_USER_PHONE_HINT);
  }
}

/** Vendor Portal > My Users create / edit (`#/vendors/vendor-user`): the "Text messages" tick next to Truck Driver (`#vendor-user-notify-by-sms`). */
export class VendorUserTextMessagesPage extends VendorUserFormPage {
  readonly textMessages: TextMessagesField;
  readonly phone: PhoneField;
  readonly pendingChanges: Locator;

  constructor(page: Page) {
    super(page);
    this.textMessages = new TextMessagesField(page.locator('#vendor-user-notify-by-sms'));
    this.phone = new PhoneField(page);
    this.pendingChanges = page.getByTestId('pending-change');
  }

  async expectContactLocked(): Promise<void> {
    await expectContactLocked(this.textMessages, this.phone);
  }

  async expectContactForDriverApproval(): Promise<void> {
    await expectContactForDriverApproval(this.textMessages, this.phone);
  }

  async expectTextsOnlyDriverCanTurnOff(): Promise<void> {
    await expectTextsOnlyDriverCanTurnOff(this.textMessages, this.phone);
  }

  async expectContactEditable(): Promise<void> {
    await expectContactEditable(this.textMessages, this.phone);
  }
}

/**
 * A host-app browser context of its own for one host-only user, signed in through the host API's own `api/account/login`
 * and stored the way the app's AuthService stores a sign-in (as `DispatchContactSession` does), so the case reaches the
 * user forms without going through Identity.
 */
export class NotifyBySmsSession {
  readonly adminUser: AdminUserTextMessagesPage;
  readonly vendorUser: VendorUserTextMessagesPage;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly api: NotifyBySmsApi,
  ) {
    this.adminUser = new AdminUserTextMessagesPage(page);
    this.vendorUser = new VendorUserTextMessagesPage(page);
  }

  static async signIn(browser: Browser, credentials: Credentials): Promise<NotifyBySmsSession> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 1000 },
      storageState: { cookies: [], origins: [] },
    });
    try {
      const api = new NotifyBySmsApi(context.request);
      const login = await api.signIn(credentials.email, credentials.password);
      const claims = JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString('utf8')) as Record<string, string>;
      await context.addInitScript(
        ({ login, claims }) => {
          if (sessionStorage.getItem('e2eSeeded')) return;
          sessionStorage.setItem('e2eSeeded', '1');
          localStorage.setItem('isLoggedOut', 'false');
          localStorage.setItem('accessToken', login.accessToken);
          localStorage.setItem('refreshToken', login.refreshToken);
          localStorage.setItem('refreshTokenExpiredAt', login.refreshTokenExpiredAt);
          localStorage.setItem('userId', claims.UserId);
          localStorage.setItem('email', claims.Email);
          localStorage.setItem('roles', claims.Roles);
          localStorage.setItem('fullName', claims.FullName);
        },
        { login, claims },
      );
      test.info().annotations.push({
        type: 'sign-in',
        description: `${credentials.email} signed in through ${env.appApiUrl}/api/account/login (no Identity round trip).`,
      });
      const page = await context.newPage();
      return new NotifyBySmsSession(context, page, api);
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
