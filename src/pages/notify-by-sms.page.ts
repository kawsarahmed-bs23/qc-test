import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { NotifyBySmsApi } from '@api/notify-by-sms.api';
import { AdminUserFormPage, VendorUserFormPage } from '@pages/user-invites.page';

export const TEXT_MESSAGES_LABEL = 'Text messages';
export const TEXT_MESSAGES_HELP = 'Texts Job offers and messages to this number.';
export const CONTACT_LOCKED_TEXT = 'Set by the Driver in the Driver App.';
export const PHONE_HINT = '10-digit US number';
export const ADMIN_USER_PHONE_HINT = 'Optional, 10-digit US number. Needed for text messages.';
export const ADMIN_USER_PLAIN_PHONE_HINT = 'Optional, 10-digit US number.';
export const TEXTS_NEED_PHONE_TEXT = 'Add a valid phone number to turn on text messages.';

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

/** What both user forms show for a linked user (QC-1009, D114): no Text messages tick, the Driver's own setting decides; the phone is the Host's own and stays editable with the usual hint. */
async function expectLinkedUser(page: Page, textMessages: TextMessagesField, phone: PhoneField, phoneHint: string): Promise<void> {
  await expect(phone.input).toBeVisible();
  await expect(textMessages.root).toHaveCount(0);
  await expect(page.getByText(CONTACT_LOCKED_TEXT)).toHaveCount(0);
  await expect(phone.input).not.toHaveAttribute('readonly', /.*/);
  await expect(phone.input).toBeEditable();
  await expect(phone.hint).toHaveText(phoneHint);
}

/** QC-991: without a valid phone the tick is unticked and disabled with the needs-a-phone line; a new user's tick turns on once a valid phone is typed. */
async function expectTextsNeedPhone(textMessages: TextMessagesField): Promise<void> {
  await expect(textMessages.checkbox).toBeVisible();
  await expect(textMessages.checkbox).not.toBeChecked();
  await expect(textMessages.checkbox).toBeDisabled();
  await expect(textMessages.help(TEXTS_NEED_PHONE_TEXT)).toBeVisible();
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
  readonly vendor: Locator;
  readonly truck: Locator;
  readonly pendingChanges: Locator;

  constructor(page: Page) {
    super(page);
    this.textMessages = new TextMessagesField(page.locator('#user-notify-by-sms'));
    this.phone = new PhoneField(page);
    this.pendingChanges = page.getByTestId('pending-change');
    this.vendor = page.getByRole('combobox', { name: 'Vendor' });
    this.truck = page.getByRole('combobox', { name: 'Truck' });
  }

  /** QC-991: a Driver is placed by choosing the Vendor first, then one of its Trucks. */
  async chooseVendorTruck(vendor: string, truck: string): Promise<void> {
    await this.vendor.click();
    await this.page.getByRole('option', { name: vendor, exact: true }).click();
    await expect(this.vendor).toContainText(vendor);
    await this.truck.click();
    await this.page.getByRole('option', { name: truck, exact: true }).click();
    await expect(this.truck).toContainText(truck);
  }

  async expectTextsNeedPhone(): Promise<void> {
    await expectTextsNeedPhone(this.textMessages);
  }

  async expectLinkedUser(): Promise<void> {
    await expectLinkedUser(this.page, this.textMessages, this.phone, ADMIN_USER_PLAIN_PHONE_HINT);
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

  async expectLinkedUser(): Promise<void> {
    await expectLinkedUser(this.page, this.textMessages, this.phone, PHONE_HINT);
  }

  async expectTextsNeedPhone(): Promise<void> {
    await expectTextsNeedPhone(this.textMessages);
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
