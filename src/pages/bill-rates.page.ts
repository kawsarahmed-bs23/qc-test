import { devices, expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { BasePage } from './base.page';
import { AppSignInPage } from './app.page';
import { IdentityLoginPage, IdentityTwoStepPage } from './identity-login.page';
import { secondsLeftInStep, totp } from '@utils/totp';

export const BILL_RATES_LABEL = 'Drivers can see Bill Rates';
export const BILL_RATES_HELP =
  'Drivers of this Vendor see the rates you pay this Vendor on each Job assignment, in the Driver App and Drivers Portal. Customer prices are never shown.';
export const BILL_RATES_SAVED = 'Your setting is saved.';

/** Edit Vendor (`#/admin/vendor/<id>`) in the host app: the QC-827 "Drivers can see Bill Rates" checkbox, saved with the page's Save. */
export class EditVendorPage extends BasePage {
  protected readonly path = '/#/admin/vendor';
  readonly billRates: Locator;
  readonly billRatesCheckbox: Locator;
  readonly billRatesHelp: Locator;
  readonly vendorName: Locator;
  readonly locationName: Locator;
  readonly address1: Locator;
  readonly save: Locator;

  constructor(page: Page) {
    super(page);
    this.billRates = page.getByTestId('drivers-can-see-bill-rates');
    this.billRatesCheckbox = this.billRates.getByRole('checkbox', { name: BILL_RATES_LABEL });
    this.billRatesHelp = this.billRates.getByText(BILL_RATES_HELP);
    this.vendorName = page.getByRole('textbox', { name: 'Vendor Name' });
    this.locationName = page.getByRole('textbox', { name: 'Location Name' });
    this.address1 = page.getByRole('textbox', { name: 'Address 1' });
    this.save = page.getByRole('button', { name: 'Save' });
  }

  async open(vendorId: number): Promise<void> {
    const loaded = this.page.waitForResponse(
      (r) => r.request().method() === 'GET' && new RegExp(`/api/organisation/vendor-edit/${vendorId}$`).test(new URL(r.url()).pathname),
    );
    await this.page.goto(`${this.path}/${vendorId}`);
    expect((await loaded).status(), 'GET vendor-edit answers 200').toBe(200);
    await expect(this.vendorName).not.toHaveValue('', { timeout: 30_000 });
    await expect(this.billRatesCheckbox).toBeVisible();
  }

  /** The vendor's address card is required by the form; a throwaway vendor has none, so the test fills one in. */
  async fillAddressIfEmpty(name: string, line1: string): Promise<void> {
    if ((await this.locationName.inputValue()) === '') await this.locationName.fill(name);
    if ((await this.address1.inputValue()) === '') {
      await this.address1.fill(line1);
      await this.address1.press('Escape');
    }
  }

  /** Presses Save and returns the vendor-edit POST status. */
  async saveVendor(): Promise<number> {
    const saved = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/organisation\/vendor-edit$/i.test(new URL(r.url()).pathname));
    await this.save.click();
    return (await saved).status();
  }
}

/** My Profile (`#/my-profile`) for a Vendor-role user: the QC-827 card whose checkbox saves the switch at once. */
export class VendorProfileBillRatesPage extends BasePage {
  protected readonly path = '/#/my-profile';
  readonly card: Locator;
  readonly checkbox: Locator;
  readonly help: Locator;
  readonly savedNotice: Locator;

  constructor(page: Page) {
    super(page);
    this.card = page.locator('mat-card').filter({ has: page.getByTestId('profile-drivers-can-see-bill-rates') });
    this.checkbox = page.getByTestId('profile-drivers-can-see-bill-rates').getByRole('checkbox', { name: BILL_RATES_LABEL });
    this.help = this.card.getByText(BILL_RATES_HELP);
    this.savedNotice = page.locator('.success-snackbar').filter({ hasText: BILL_RATES_SAVED });
  }

  async open(): Promise<void> {
    await this.page.goto(this.path);
    await expect(this.page.getByRole('heading', { name: 'Profile Information' })).toBeVisible({ timeout: 30_000 });
    await expect(this.checkbox).toBeVisible({ timeout: 15_000 });
  }

  /** Clicks the checkbox and returns the status of the bill-rates POST it sends. */
  async toggle(): Promise<number> {
    const saved = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/vendor\/settings\/bill-rates$/i.test(new URL(r.url()).pathname));
    await this.checkbox.click();
    return (await saved).status();
  }
}

/** A host-app browser context of its own for one user (the host admin, or the throwaway Vendor-role user with two-step). */
export class BillRatesSession {
  readonly editVendor: EditVendorPage;
  readonly profile: VendorProfileBillRatesPage;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.editVendor = new EditVendorPage(page);
    this.profile = new VendorProfileBillRatesPage(page);
  }

  static async signIn(browser: Browser, credentials: Credentials, authenticatorKey: string | null): Promise<BillRatesSession> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await BillRatesSession.alignOidcAuthority(context);
      await BillRatesSession.allowAppOrigin(context);
      if (authenticatorKey) {
        await page.goto('/');
        await new IdentityLoginPage(page).signIn(credentials);
        await BillRatesSession.verifyTwoStep(page, authenticatorKey);
        await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
      } else {
        const signIn = new AppSignInPage(page);
        await signIn.open();
        await signIn.signIn(credentials);
      }
      await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
    } catch (error) {
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
      throw error;
    }
    return new BillRatesSession(context, page);
  }

  /**
   * The host app's preboot reads oidc/config.js, which must name the same Identity as environment.ts. A side-by-side stack
   * that moved environment.ts to another Identity but not oidc/config.js sends the browser to the wrong Identity, which
   * refuses the app's return address. When the served authority is not IDENTITY_URL, this context gets config.js with
   * IDENTITY_URL instead, and the test is annotated so the report says so.
   */
  /**
   * A host API started before its EnvironmentSetting Cors:AllowedOrigins named APP_URL answers the app without CORS headers
   * (Program.cs reads the list once at start-up), so the browser drops every API answer. When a preflight from APP_URL gets no
   * Access-Control-Allow-Origin, this context adds the CORS headers to APP_API_URL answers, and the test is annotated.
   */
  private static async allowAppOrigin(context: BrowserContext): Promise<void> {
    const origin = new URL(env.appUrl!).origin;
    const preflight = await context.request.fetch(`${env.appApiUrl}/api/setting/public/company-settings`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
    });
    if (preflight.headers()['access-control-allow-origin']) return;
    test.info().annotations.push({
      type: 'environment',
      description: `${env.appApiUrl} does not allow the origin ${origin} (CORS list read at start-up); this test's browser context added the CORS headers.`,
    });
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'authorization, content-type, x-requested-with, x-host-uuid',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-expose-headers': 'content-disposition',
    };
    await context.route(`${env.appApiUrl}/**`, async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      try {
        const response = await route.fetch({ maxRedirects: 0 });
        await route.fulfill({ response, headers: { ...response.headers(), ...cors } });
      } catch {
        await route.abort().catch(() => undefined);
      }
    });
  }

  private static async alignOidcAuthority(context: BrowserContext): Promise<void> {
    const served = await context.request.get(`${env.appUrl}/oidc/config.js`);
    const script = served.ok() ? await served.text() : '';
    const authority = /authority:\s*'([^']+)'/.exec(script)?.[1];
    if (!authority || authority.replace(/\/+$/, '') === env.identityUrl) return;
    test.info().annotations.push({
      type: 'environment',
      description: `${env.appUrl}/oidc/config.js names ${authority}, not IDENTITY_URL ${env.identityUrl}; this test's browser context was given IDENTITY_URL.`,
    });
    const fixed = script.replace(authority, env.identityUrl);
    await context.route('**/oidc/config.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: fixed }));
  }

  /** Identity's two-step page: six digit boxes in current builds, one code field (#Input_Code) in older ones. */
  private static async verifyTwoStep(page: Page, authenticatorKey: string): Promise<void> {
    await expect(page).toHaveURL(/\/Account\/LoginWith2fa/i, { timeout: 30_000 });
    const twoStep = new IdentityTwoStepPage(page);
    await expect(twoStep.code).toBeAttached();
    if ((await twoStep.digits.count()) === 6) {
      await twoStep.verify(authenticatorKey);
      return;
    }
    if (secondsLeftInStep() < 3) await expect.poll(() => secondsLeftInStep(), { timeout: 5_000 }).toBeGreaterThan(20);
    await twoStep.code.fill(totp(authenticatorKey));
    await twoStep.submit.click();
  }

  async close(): Promise<void> {
    await this.context.unrouteAll({ behavior: 'ignoreErrors' });
    await this.context.close();
  }
}
