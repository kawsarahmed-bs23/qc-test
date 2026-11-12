import { expect, type Browser, type Locator, type Page, type Route } from '@playwright/test';
import type { Credentials } from '@config/env.config';
import { BasePage } from './base.page';
import { AppToasts, DispatchContactSession } from './dispatch-contact.page';

/** The Host's short name for an organisation, as CommonHelper.GenerateShortName makes it: the first letter of each word, upper case. */
export function generatedShortName(name: string): string {
  return name
    .split(/[ \-_]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase())
    .join('');
}

export const TRUCK_NUMBER_TAKEN = 'Truck number is already used by another truck of this vendor.';
export const NO_TRUCK_NUMBER = '--';

export interface TruckSaveAnswer {
  status: number;
  id: number | null;
  validationErrors: Record<string, string[]>;
  text: string;
}

function readSave(status: number, text: string): TruckSaveAnswer {
  let id: number | null = null;
  let validationErrors: Record<string, string[]> = {};
  try {
    const body = JSON.parse(text);
    if (typeof body?.data === 'number') id = body.data;
    else if (typeof body?.data?.organisationId === 'number') id = body.data.organisationId;
    else if (typeof body?.data?.truckId === 'number') id = body.data.truckId;
    validationErrors = body?.validationErrors ?? {};
  } catch {
    id = null;
  }
  return { status, id, validationErrors, text };
}

/** The validation messages of one field, whatever the casing of the key the API used (`TruckNumber` / `truckNumber`). */
export function fieldErrors(answer: TruckSaveAnswer, field: string): string[] {
  const key = Object.keys(answer.validationErrors).find((k) => k.toLowerCase() === field.toLowerCase());
  return key ? answer.validationErrors[key] : [];
}

abstract class TruckFormPage extends BasePage {
  protected abstract readonly api: string;
  readonly truckName: Locator;
  readonly truckNumber: Locator;
  readonly truckNumberError: Locator;
  readonly save: Locator;
  readonly toasts: AppToasts;

  constructor(page: Page, nameLabel: string) {
    super(page);
    this.truckName = page.getByRole('textbox', { name: nameLabel });
    this.truckNumber = page.getByRole('textbox', { name: 'Truck Number' });
    this.truckNumberError = page.locator('mat-form-field').filter({ has: this.truckNumber }).locator('mat-error');
    this.save = page.getByRole('button', { name: 'Save', exact: true });
    this.toasts = new AppToasts(page);
  }

  /** Opens Create (no id) or Edit (`<path>/<id>`) with a full reload and waits for the form's GET. */
  async open(id?: number): Promise<void> {
    const getPath = id ? `${this.api}-edit/${id}` : `${this.api}-create`;
    const loaded = this.page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(getPath));
    await this.page.goto(id ? `${this.path}/${id}` : this.path);
    await this.page.reload();
    expect((await loaded).status(), `GET ${getPath}`).toBe(200);
    await expect(this.truckName).toBeVisible({ timeout: 30_000 });
    if (id) await expect(this.truckName).not.toHaveValue('');
  }

  async expectTruckNumberIsOptional(): Promise<void> {
    await expect(this.truckNumber).not.toHaveAttribute('required', /.*/);
    await expect(this.truckNumber).toHaveAttribute('aria-required', 'false');
  }

  /**
   * Presses Save and returns the create / edit POST answer. The POST is passed through a route so its body is read before
   * the page navigates back to the list (after which the browser no longer has it).
   */
  async submit(): Promise<TruckSaveAnswer> {
    const matches = (url: URL) => url.pathname.endsWith(`${this.api}-create`) || url.pathname.endsWith(`${this.api}-edit`);
    let resolve!: (answer: TruckSaveAnswer) => void;
    const answer = new Promise<TruckSaveAnswer>((r) => (resolve = r));
    const handler = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      resolve(readSave(response.status(), await response.text()));
      await route.fulfill({ response });
    };
    await this.page.route(matches, handler);
    try {
      await this.save.click();
      return await answer;
    } finally {
      await this.page.unroute(matches, handler);
    }
  }
}

/** Host > Manage Trucks Create / Edit (`#/admin/truck[/<id>]`): Vendor, Truck Name, the optional Truck Number and the address card. */
export class HostTruckFormPage extends TruckFormPage {
  protected readonly path = '/#/admin/truck';
  protected readonly api = '/api/organisation/truck';
  readonly vendor: Locator;
  readonly locationName: Locator;
  readonly address1: Locator;

  constructor(page: Page) {
    super(page, 'Truck Name');
    this.vendor = page.getByRole('combobox', { name: 'Vendor' });
    this.locationName = page.getByRole('textbox', { name: 'Location Name' });
    this.address1 = page.getByRole('textbox', { name: 'Address 1' });
  }

  async chooseVendor(name: string): Promise<void> {
    await this.vendor.click();
    await this.page.getByRole('option', { name, exact: true }).click();
    await expect(this.vendor).toContainText(name);
  }

  /** Fills the required address card (a new truck has none); the Address 1 autocomplete is closed with Escape. */
  async fillAddressIfEmpty(name: string, line1: string): Promise<void> {
    if ((await this.locationName.inputValue()) === '') await this.locationName.fill(name);
    if ((await this.address1.inputValue()) === '') {
      await this.address1.fill(line1);
      await this.address1.press('Escape');
    }
  }

  async fill(truck: { vendor?: string; name?: string; number?: string }): Promise<void> {
    if (truck.vendor) await this.chooseVendor(truck.vendor);
    if (truck.name !== undefined) await this.truckName.fill(truck.name);
    if (truck.number !== undefined) await this.truckNumber.fill(truck.number);
    await this.fillAddressIfEmpty('E2E QC-922 Yard', '922 Congress Ave');
  }
}

/** Vendor Portal Create / Edit Truck (`#/vendors/vendor-truck[/<id>]`): Truck Name and the optional Truck Number. */
export class VendorTruckFormPage extends TruckFormPage {
  protected readonly path = '/#/vendors/vendor-truck';
  protected readonly api = '/api/vendor/truck';

  constructor(page: Page) {
    super(page, 'Truck Name');
  }

  async fill(truck: { name?: string; number?: string }): Promise<void> {
    if (truck.name !== undefined) await this.truckName.fill(truck.name);
    if (truck.number !== undefined) await this.truckNumber.fill(truck.number);
  }
}

abstract class TruckListPage extends BasePage {
  protected abstract readonly api: string;
  readonly filter: Locator;
  readonly rows: Locator;

  constructor(page: Page) {
    super(page);
    this.filter = page.getByRole('textbox', { name: 'Filter' });
    this.rows = page.locator('table[mat-table] tr[mat-row]');
  }

  /** Opens the list and filters it by `keywords`, waiting for the filtered list POST. */
  async open(keywords: string): Promise<void> {
    const first = this.page.waitForResponse((r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(this.api));
    await this.page.goto(this.path);
    await this.page.reload();
    expect((await first).status(), `POST ${this.api}`).toBe(200);
    const filtered = this.page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(this.api) && (r.request().postData() ?? '').includes(keywords),
    );
    await this.filter.fill(keywords);
    await this.filter.press('Enter');
    expect((await filtered).status(), `POST ${this.api} filtered`).toBe(200);
  }

  /** The row whose ID link points at the truck. */
  row(truckId: number): Locator {
    return this.rows.filter({ has: this.page.locator(`a[href$="/${truckId}"]`) });
  }

  protected abstract numberCell(truckId: number): Locator;

  async expectNumber(truckId: number, number: string): Promise<void> {
    await expect(this.numberCell(truckId)).toHaveText(number);
  }
}

/** Host > Manage Trucks list (`#/admin/trucks`): the Truck Number column (`mat-column-truckNumber`), "--" when empty. */
export class HostTrucksListPage extends TruckListPage {
  protected readonly path = '/#/admin/trucks';
  protected readonly api = '/api/organisation/truck-search';
  readonly numberHeader: Locator;

  constructor(page: Page) {
    super(page);
    this.numberHeader = page.locator('th.mat-column-truckNumber');
  }

  protected numberCell(truckId: number): Locator {
    return this.row(truckId).locator('td.mat-column-truckNumber');
  }
}

/** Vendor Portal Trucks list (`#/vendors/vendor-trucks`): the Truck column (`mat-column-truckNumber`), "--" when empty. */
export class VendorTrucksListPage extends TruckListPage {
  protected readonly path = '/#/vendors/vendor-trucks';
  protected readonly api = '/api/vendor/truck-search';

  protected numberCell(truckId: number): Locator {
    return this.row(truckId).locator('td.mat-column-truckNumber');
  }
}

/** A Vendor Portal browser session of its own for a Vendor-role user (signed in through the host API, no Identity round trip). */
export class VendorPortalTrucks {
  private constructor(
    private readonly session: DispatchContactSession,
    readonly form: VendorTruckFormPage,
    readonly list: VendorTrucksListPage,
  ) {}

  static async signIn(browser: Browser, credentials: Credentials): Promise<VendorPortalTrucks> {
    const session = await DispatchContactSession.signIn(browser, credentials);
    return new VendorPortalTrucks(session, new VendorTruckFormPage(session.page), new VendorTrucksListPage(session.page));
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

/** Dispatch > Schedule (`#/dispatch/schedule?date=<yyyy-MM-dd>`): driver row labels and the Assign Truck dialog's truck options. */
export class TruckNumberSchedulePage extends BasePage {
  protected readonly path = '/#/dispatch/schedule';
  readonly rowLabels: Locator;
  readonly assignTruck: Locator;
  readonly dialog: Locator;
  readonly vendor: Locator;
  readonly truck: Locator;

  constructor(page: Page) {
    super(page);
    this.rowLabels = page.locator('.resource-info .driver-name');
    this.assignTruck = page.getByRole('button', { name: 'Assign Truck' });
    this.dialog = page.locator('app-assign-truck-dialog');
    this.vendor = this.dialog.getByRole('combobox', { name: 'Vendor' });
    this.truck = this.dialog.getByRole('combobox', { name: 'Truck (optional)' });
  }

  async open(date: string): Promise<void> {
    const board = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/dispatch\/board$/.test(new URL(r.url()).pathname));
    await this.page.goto(`${this.path}?date=${date}`);
    await this.page.reload();
    expect((await board).status(), 'GET dispatch/board').toBe(200);
  }

  rowLabel(text: string): Locator {
    return this.rowLabels.filter({ hasText: text });
  }

  async openAssignDialog(): Promise<void> {
    await this.assignTruck.click();
    await expect(this.dialog).toBeVisible();
  }

  async truckOptionsOf(vendor: string): Promise<Locator> {
    await this.vendor.click();
    await this.page.getByRole('option', { name: vendor, exact: true }).click();
    await this.truck.click();
    return this.page.getByRole('option');
  }
}
