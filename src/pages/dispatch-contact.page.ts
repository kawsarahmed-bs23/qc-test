import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { DispatchContactApi } from '@api/dispatch-contact.api';
import { BasePage } from './base.page';
import { CommsPage } from './app.page';
import { CopyScheduleDialogPage } from './sms-routing.page';

export const DISPATCH_CONTACT_LABEL = 'Is dispatch contact';
export const MISSING_DISPATCH_CONTACT = 'Set a Dispatch Contact for this Vendor. Vendor-only Job offers go to that user.';
export const MISSING_CONTACT_PHONE = "That Vendor's Dispatch Contact has no phone number on file, so no SMS can be sent.";
export const DISPATCH_CONTACT_HINT =
  'A Vendor user who also drives stays a Vendor user: tick "Is dispatch contact" on their user to send them the Vendor-only Job offers, instead of moving them.';
export const MOVE_MESSAGE = 'A user belongs to one organisation, so saving moves them.';

export function contactChangedMessage(from: string, to: string): string {
  return `Dispatch contact changed from ${from} to ${to}.`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The success / error snackbars the host app shows after a save. */
export class AppToasts {
  readonly success: Locator;
  readonly error: Locator;

  constructor(page: Page) {
    this.success = page.locator('.success-snackbar');
    this.error = page.locator('.error-snackbar');
  }

  async expectSuccess(text: string): Promise<void> {
    await expect(this.success.filter({ hasText: text })).toBeVisible({ timeout: 15_000 });
  }
}

export type DispatchContactChange = 'replace' | 'leave';

const CHANGE_DIALOG: Record<DispatchContactChange, { title: string; confirm: string }> = {
  replace: { title: 'Replace the dispatch contact?', confirm: 'Replace and save' },
  leave: { title: 'Leave this Vendor without a dispatch contact?', confirm: 'Untick and save' },
};

/** The QC-910 confirm dialog (shared ConfirmDialogComponent) before a save replaces or clears a Vendor's dispatch contact. */
export class DispatchContactDialog {
  readonly root: Locator;
  readonly message: Locator;
  readonly cancel: Locator;

  constructor(page: Page) {
    this.root = page.locator('app-confirm-dialog');
    this.message = this.root.locator('.confirm-dialog__message');
    this.cancel = this.root.getByRole('button', { name: 'Cancel' });
  }

  confirm(change: DispatchContactChange): Locator {
    return this.root.getByRole('button', { name: CHANGE_DIALOG[change].confirm });
  }

  async expectOpen(change: DispatchContactChange, message?: string): Promise<void> {
    await expect(this.root).toHaveCount(1);
    await expect(this.root.getByRole('heading', { name: CHANGE_DIALOG[change].title })).toBeVisible();
    await expect(this.confirm(change)).toBeVisible();
    if (message) await expect(this.message).toContainText(message);
  }
}

/** Counts the POSTs to one API path a page sends from now on, so a Cancel can be proved to send none. */
function countPosts(page: Page, pathname: RegExp): () => number {
  let count = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && pathname.test(new URL(r.url()).pathname)) count++;
  });
  return () => count;
}

abstract class DispatchContactUserPage extends BasePage {
  protected abstract readonly apiArea: string;
  readonly dispatchContact: Locator;
  readonly dispatchContactHelp: Locator;
  readonly save: Locator;
  readonly editHeading: Locator;
  readonly changeDialog: DispatchContactDialog;
  readonly toasts: AppToasts;

  constructor(page: Page, help: string) {
    super(page);
    this.dispatchContact = page.getByRole('checkbox', { name: DISPATCH_CONTACT_LABEL });
    this.dispatchContactHelp = page.getByText(help);
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.editHeading = page.getByRole('heading', { name: 'Edit User', exact: true }).first();
    this.changeDialog = new DispatchContactDialog(page);
    this.toasts = new AppToasts(page);
  }

  /** Presses Save, expects the replace / leave-without dialog, confirms it and returns the user-edit POST status and message. */
  async saveUserConfirming(change: DispatchContactChange, message?: string): Promise<{ status: number; message: string | null }> {
    const saved = this.page.waitForResponse(
      (r) => r.request().method() === 'POST' && new RegExp(`/api/${this.apiArea}/user-edit$`).test(new URL(r.url()).pathname),
    );
    await this.save.click();
    await this.changeDialog.expectOpen(change, message);
    await this.changeDialog.confirm(change).click();
    const response = await saved;
    const body = await response.json().catch(() => null);
    return { status: response.status(), message: typeof body?.message === 'string' ? body.message : null };
  }

  countSaves(): () => number {
    return countPosts(this.page, new RegExp(`/api/${this.apiArea}/user-edit$`));
  }

  /** Opens the edit page with a full reload and waits for its user-edit GET. */
  async open(userId?: string): Promise<void> {
    const loaded = userId
      ? this.page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes(`/api/${this.apiArea}/user-edit/${encodeURIComponent(userId)}`))
      : null;
    await this.page.goto(userId ? `${this.path}/${encodeURIComponent(userId)}` : this.path);
    await this.page.reload();
    if (loaded) expect((await loaded).status(), 'GET user-edit').toBe(200);
    await expect(this.page.getByRole('heading', { name: userId ? 'Edit User' : 'Create New User', exact: true }).first()).toBeVisible({ timeout: 30_000 });
  }

  /** Presses Save and returns the user-edit POST status and the message it carries. */
  async saveUser(): Promise<{ status: number; message: string | null }> {
    const saved = this.page.waitForResponse(
      (r) => r.request().method() === 'POST' && new RegExp(`/api/${this.apiArea}/user-edit$`).test(new URL(r.url()).pathname),
    );
    await this.save.click();
    const response = await saved;
    const body = await response.json().catch(() => null);
    return { status: response.status(), message: typeof body?.message === 'string' ? body.message : null };
  }
}

/** Admin > Users edit (`#/admin/user/<id>`) and create (`#/admin/user`): the QC-910 "Is dispatch contact" tick for a Vendor-role user. */
export class AdminUserDispatchContactPage extends DispatchContactUserPage {
  protected readonly path = '/#/admin/user';
  protected readonly apiArea = 'manageusers';
  readonly role: Locator;
  readonly billingContact: Locator;
  readonly active: Locator;

  constructor(page: Page) {
    super(page, "Receives this Vendor's Vendor-only Job offers. One per Vendor.");
    this.role = page.getByRole('combobox', { name: 'Role' });
    this.billingContact = page.getByRole('checkbox', { name: 'Is billing contact' });
    this.active = page.getByRole('checkbox', { name: 'Active', exact: true });
  }

  async chooseRole(role: string): Promise<void> {
    await this.role.click();
    await this.page.getByRole('option', { name: role, exact: true }).click();
  }
}

/** Vendor Portal > My Users edit (`#/vendors/vendor-user/<id>`): the tick shows only while "Truck Driver" is unticked. */
export class VendorUserDispatchContactPage extends DispatchContactUserPage {
  protected readonly path = '/#/vendors/vendor-user';
  protected readonly apiArea = 'vendor';
  readonly truckDriver: Locator;

  constructor(page: Page) {
    super(page, 'Receives your Vendor-only Job offers. One user per Vendor.');
    this.truckDriver = page.getByRole('checkbox', { name: 'Truck Driver' });
  }
}

/** My Profile (`#/my-profile`) for a Vendor-role user: the QC-910 checkbox in the Vendor card, saved at once. */
export class ProfileDispatchContactPage extends BasePage {
  protected readonly path = '/#/my-profile';
  readonly field: Locator;
  readonly checkbox: Locator;
  readonly card: Locator;
  readonly changeDialog: DispatchContactDialog;
  readonly toasts: AppToasts;

  constructor(page: Page) {
    super(page);
    this.field = page.getByTestId('profile-is-dispatch-contact');
    this.checkbox = this.field.getByRole('checkbox', { name: DISPATCH_CONTACT_LABEL });
    this.card = page.locator('mat-card').filter({ has: this.field });
    this.changeDialog = new DispatchContactDialog(page);
    this.toasts = new AppToasts(page);
  }

  countSaves(): () => number {
    return countPosts(this.page, /\/api\/vendor\/settings\/dispatch-contact$/);
  }

  async open(): Promise<void> {
    const loaded = this.page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/vendor\/settings\/dispatch-contact$/.test(new URL(r.url()).pathname),
    );
    await this.page.goto(this.path);
    await this.page.reload();
    expect((await loaded).status(), 'GET dispatch-contact').toBe(200);
    await expect(this.checkbox).toBeVisible({ timeout: 15_000 });
  }

  todayIs(name: string): Locator {
    return this.card.getByText(`Today that is ${name}; ticking this makes it you.`);
  }

  /** Clicks the checkbox, confirms the replace / leave-without dialog when one is expected, and returns the dispatch-contact POST status. */
  async toggle(change?: DispatchContactChange): Promise<number> {
    const saved = this.page.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/vendor\/settings\/dispatch-contact$/.test(new URL(r.url()).pathname),
    );
    await this.checkbox.click();
    if (change) {
      await this.changeDialog.expectOpen(change);
      await this.changeDialog.confirm(change).click();
    }
    return (await saved).status();
  }
}

/** The shared confirm dialog Edit Vendor / Edit Truck open before saving a user who belongs to another organisation (SETUP_004). */
export class MoveUserDialog {
  readonly root: Locator;
  readonly items: Locator;
  readonly moveAndSave: Locator;
  readonly cancel: Locator;

  constructor(page: Page) {
    this.root = page.locator('app-confirm-dialog');
    this.items = this.root.getByRole('listitem');
    this.moveAndSave = this.root.getByRole('button', { name: 'Move and save' });
    this.cancel = this.root.getByRole('button', { name: 'Cancel' });
  }

  async expectMove(target: 'Vendor' | 'Truck', line: string): Promise<void> {
    await expect(this.root).toBeVisible();
    await expect(this.root.getByRole('heading', { name: `Move this user to this ${target}?` })).toBeVisible();
    await expect(this.root.getByText(MOVE_MESSAGE)).toBeVisible();
    await expect(this.items).toHaveText([line, DISPATCH_CONTACT_HINT]);
  }
}

abstract class OrganisationUsersPage extends BasePage {
  protected abstract readonly editApi: string;
  protected abstract readonly nameLabel: string;
  readonly associatedUsers: Locator;
  readonly locationName: Locator;
  readonly address1: Locator;
  readonly save: Locator;
  /** The same Save button found by its loader's `text` attribute, since its accessible name is hidden while it saves. */
  readonly saveButton: Locator;
  readonly moveDialog: MoveUserDialog;
  readonly toasts: AppToasts;

  constructor(page: Page) {
    super(page);
    this.associatedUsers = page.getByRole('combobox', { name: 'Associated Users' });
    this.locationName = page.getByRole('textbox', { name: 'Location Name' });
    this.address1 = page.getByRole('textbox', { name: 'Address 1' });
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.saveButton = page.locator('form button').filter({ has: page.locator('app-button-loader[text="Save"]') });
    this.moveDialog = new MoveUserDialog(page);
    this.toasts = new AppToasts(page);
  }

  async open(organisationId: number): Promise<void> {
    const loaded = this.page.waitForResponse(
      (r) => r.request().method() === 'GET' && new RegExp(`/api/organisation/${this.editApi}/${organisationId}$`).test(new URL(r.url()).pathname),
    );
    await this.page.goto(`${this.path}/${organisationId}`);
    await this.page.reload();
    expect((await loaded).status(), `GET ${this.editApi}`).toBe(200);
    await expect(this.page.getByRole('textbox', { name: this.nameLabel })).not.toHaveValue('', { timeout: 30_000 });
  }

  /** Ticks one more user in the Associated Users multi-select, by the option text the page shows. */
  /** Two clicks in one task, before the move dialog renders: a real double-click's second click lands on the dialog backdrop instead. */
  async doubleSubmit(): Promise<void> {
    await this.saveButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  }

  async addAssociatedUser(option: string | RegExp): Promise<void> {
    await this.associatedUsers.click();
    const choice = this.page.getByRole('option', { name: option });
    await choice.scrollIntoViewIfNeeded();
    await expect(choice).toHaveAttribute('aria-selected', 'false');
    await choice.click();
    await expect(choice).toHaveAttribute('aria-selected', 'true');
    await this.page.keyboard.press('Escape');
  }

  /** The address card is required by the form; a throwaway organisation has none, so the test fills one in. */
  async fillAddressIfEmpty(name: string, line1: string): Promise<void> {
    if ((await this.locationName.inputValue()) === '') await this.locationName.fill(name);
    if ((await this.address1.inputValue()) === '') {
      await this.address1.fill(line1);
      await this.address1.press('Escape');
    }
  }

  saveRequest(): Promise<import('@playwright/test').Response> {
    return this.page.waitForResponse(
      (r) => r.request().method() === 'POST' && new RegExp(`/api/organisation/${this.editApi}$`).test(new URL(r.url()).pathname),
    );
  }

  /** Counts the edit POSTs this page sends from now on, so a Cancel can be proved to send none. */
  countSaves(): () => number {
    let count = 0;
    this.page.on('request', (r) => {
      if (r.method() === 'POST' && new RegExp(`/api/organisation/${this.editApi}$`).test(new URL(r.url()).pathname)) count++;
    });
    return () => count;
  }
}

/** Edit Vendor (`#/admin/vendor/<id>`): Associated Users, the QC-910 "Dispatch contact: <name>" line and the move warning. */
export class EditVendorDispatchPage extends OrganisationUsersPage {
  protected readonly path = '/#/admin/vendor';
  protected readonly editApi = 'vendor-edit';
  protected readonly nameLabel = 'Vendor Name';
  readonly dispatchContact: Locator;

  constructor(page: Page) {
    super(page);
    this.dispatchContact = page.getByTestId('vendor-dispatch-contact');
  }

  async expectDispatchContact(name: string | null): Promise<void> {
    if (name) {
      await expect(this.dispatchContact).toHaveText(new RegExp(`^\\s*Dispatch contact:\\s*${escapeRegExp(name)}\\s*$`));
    } else {
      await expect(this.dispatchContact).toHaveText(
        /^\s*Dispatch contact:\s*None\s*\(Vendor-only Job offers need one: tick "Is dispatch contact" on a Vendor user\)\s*$/,
      );
    }
  }
}

/** Edit Truck (`#/admin/truck/<id>`): Associated Users and the move warning. */
export class EditTruckDispatchPage extends OrganisationUsersPage {
  protected readonly path = '/#/admin/truck';
  protected readonly editApi = 'truck-edit';
  protected readonly nameLabel = 'Truck Name';
}

/**
 * Dispatch > Schedule (`#/dispatch/schedule`) and its Assign Truck dialog: the QC-910 Vendor-only dispatch-contact notes and,
 * since QC-930, the Offer Message box with its delivery line (the "Send Message Via SMS" tick is retired).
 */
export class AssignDialogDispatchPage extends BasePage {
  protected readonly path = '/#/dispatch/schedule';
  readonly assignTruck: Locator;
  readonly dialog: Locator;
  readonly order: Locator;
  readonly vendor: Locator;
  readonly truck: Locator;
  readonly missingContact: Locator;
  readonly contactNote: Locator;
  readonly retiredSmsTick: Locator;
  readonly offerMessage: Locator;
  readonly offerDelivery: Locator;
  readonly save: Locator;
  readonly cancel: Locator;

  constructor(page: Page) {
    super(page);
    this.assignTruck = page.getByRole('button', { name: 'Assign Truck' });
    this.dialog = page.locator('app-assign-truck-dialog');
    this.order = this.dialog.getByRole('combobox', { name: 'Order' });
    this.vendor = this.dialog.getByRole('combobox', { name: 'Vendor' });
    this.truck = this.dialog.getByRole('combobox', { name: 'Truck (optional)' });
    this.missingContact = this.dialog.getByTestId('assign-missing-dispatch-contact');
    this.contactNote = this.dialog.getByTestId('assign-dispatch-contact');
    this.retiredSmsTick = this.dialog.getByRole('checkbox', { name: 'Send Message Via SMS' });
    this.offerMessage = this.dialog.getByRole('textbox', { name: 'Offer Message' });
    this.offerDelivery = this.dialog.getByTestId('assign-offer-delivery');
    this.save = page.getByRole('button', { name: 'Save assignment' });
    this.cancel = page.locator('mat-dialog-actions').getByRole('button', { name: 'Cancel' });
  }

  async openSchedule(date?: string): Promise<void> {
    const board = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/dispatch\/board$/.test(new URL(r.url()).pathname));
    await this.page.goto(date ? `${this.path}?date=${date}` : this.path);
    await this.page.reload();
    expect((await board).status(), 'GET dispatch/board').toBe(200);
  }

  async openDialog(): Promise<void> {
    const options = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/dispatch\/assign-options$/.test(new URL(r.url()).pathname));
    await this.page.goto(this.path);
    await this.page.reload();
    expect((await options).status(), 'GET assign-options').toBe(200);
    await this.assignTruck.click();
    await expect(this.dialog).toBeVisible();
  }

  async chooseOrder(orderId: number): Promise<void> {
    await this.order.click();
    await this.page.getByRole('option', { name: new RegExp(`Order #${orderId} `) }).click();
  }

  async chooseVendor(name: string): Promise<void> {
    await this.vendor.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.truck).toContainText('Vendor-level (no truck)');
  }

  async chooseTruck(label: string | RegExp): Promise<void> {
    await this.truck.click();
    await this.page.getByRole('option', { name: label }).click();
  }

  /** Opens the edit dialog of the first bar on the board row whose label contains `rowText`. */
  async openBar(rowText: string): Promise<void> {
    await this.page
      .locator('.board-row.resource-row')
      .filter({ has: this.page.locator('.driver-name', { hasText: rowText }) })
      .locator('.trip-block')
      .first()
      .click();
    await expect(this.dialog).toBeVisible();
  }

  async expectOfferBox(delivery: string | RegExp): Promise<void> {
    await expect(this.offerMessage).toBeVisible();
    await expect(this.offerDelivery).toHaveText(delivery);
    await expect(this.retiredSmsTick).toHaveCount(0);
    await expect(this.save).toHaveText('Save');
  }

  async expectNoOfferBox(): Promise<void> {
    await expect(this.offerMessage).toHaveCount(0);
    await expect(this.offerDelivery).toHaveCount(0);
    await expect(this.retiredSmsTick).toHaveCount(0);
    await expect(this.save).toHaveText('Save');
  }

  async expectMissingContact(): Promise<void> {
    await expect(this.missingContact).toHaveText(
      /^\s*Set a Dispatch Contact for this Vendor\. Vendor-only Job offers go to that user:\s*tick "Is dispatch contact" on one of the Vendor's users\.\s*$/,
    );
    await expect(this.contactNote).toHaveCount(0);
    await expect(this.offerMessage).toHaveCount(0);
    await expect(this.retiredSmsTick).toHaveCount(0);
  }

  async expectContact(name: string): Promise<void> {
    await expect(this.contactNote).toHaveText(`The offer goes to the Vendor's dispatch contact, ${name}.`);
    await expect(this.missingContact).toHaveCount(0);
    await expect(this.offerMessage).toBeVisible();
    await expect(this.retiredSmsTick).toHaveCount(0);
  }
}

/**
 * A host-app browser context of its own for one user, signed in through the host API's own `api/account/login` and stored
 * the way the app's AuthService stores a sign-in (accessToken, refreshToken, userId, email, roles, fullName), so the case
 * reaches the feature without going through Identity.
 */
export class DispatchContactSession {
  readonly adminUser: AdminUserDispatchContactPage;
  readonly vendorUser: VendorUserDispatchContactPage;
  readonly profile: ProfileDispatchContactPage;
  readonly editVendor: EditVendorDispatchPage;
  readonly editTruck: EditTruckDispatchPage;
  readonly schedule: AssignDialogDispatchPage;
  readonly comms: CommsPage;
  readonly copySchedule: CopyScheduleDialogPage;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
    readonly api: DispatchContactApi,
  ) {
    this.adminUser = new AdminUserDispatchContactPage(page);
    this.vendorUser = new VendorUserDispatchContactPage(page);
    this.profile = new ProfileDispatchContactPage(page);
    this.editVendor = new EditVendorDispatchPage(page);
    this.editTruck = new EditTruckDispatchPage(page);
    this.schedule = new AssignDialogDispatchPage(page);
    this.comms = new CommsPage(page);
    this.copySchedule = new CopyScheduleDialogPage(page);
  }

  static async signIn(browser: Browser, credentials: Credentials): Promise<DispatchContactSession> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 1000 },
      storageState: { cookies: [], origins: [] },
    });
    try {
      const api = new DispatchContactApi(context.request);
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
      return new DispatchContactSession(context, page, api);
    } catch (error) {
      await context.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}
