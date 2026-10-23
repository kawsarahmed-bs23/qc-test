import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';

export const SIGN_IN_ERROR_KEY = 'qc_oidc_sign_in_error';

export type HostSettingsModel = Record<string, unknown> & { loginSubtitle?: string | null };

export interface ApiResult<T> {
  status: number;
  data: T | null;
  validationErrors: Record<string, string[]>;
}

export class HostSettingsApi {
  private constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  static async signedIn(page: Page): Promise<HostSettingsApi> {
    if (!env.appApiUrl) {
      throw new Error('APP_API_URL is not set for this environment.');
    }
    await page.goto('/#/dashboard/dispatch-dashboard');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
    return new HostSettingsApi(page, `${env.appApiUrl}/api/setting`);
  }

  async get(): Promise<HostSettingsModel> {
    const result = await this.call<HostSettingsModel>('GET', '/host-setting');
    expect(result.status, 'GET host-setting').toBe(200);
    return result.data!;
  }

  async post(model: HostSettingsModel): Promise<ApiResult<HostSettingsModel>> {
    return this.call<HostSettingsModel>('POST', '/host-setting', model);
  }

  async setLoginSubtitle(value: string | null): Promise<ApiResult<HostSettingsModel>> {
    const model = await this.get();
    return this.post({ ...model, loginSubtitle: value });
  }

  async publicLoginSubtitle(): Promise<string | null | undefined> {
    const result = await this.call<{ loginSubtitle?: string | null }>('GET', '/public/company-settings', undefined, false);
    expect(result.status, 'GET public/company-settings').toBe(200);
    return result.data?.loginSubtitle;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, auth = true): Promise<ApiResult<T>> {
    return this.page.evaluate(
      async ({ url, method, body, auth }) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (auth) headers.Authorization = `Bearer ${localStorage.getItem('accessToken')}`;
        const response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const json = await response.json().catch(() => null);
        return { status: response.status, data: json?.data ?? null, validationErrors: json?.validationErrors ?? {} };
      },
      { url: `${this.apiUrl}${path}`, method, body, auth },
    );
  }
}

export class HostSignInScreen {
  readonly heading: Locator;
  readonly subtitle: Locator;
  readonly errorBox: Locator;

  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
  ) {
    const title = page.locator('.daxa-form .title');
    this.heading = title.locator('h3');
    this.subtitle = title.locator('.subtitle');
    this.errorBox = page.locator('.custom-error-message');
  }

  static async open(browser: Browser): Promise<HostSignInScreen> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      storageState: { cookies: [], origins: [] },
    });
    await context.addInitScript(({ key, origin }) => {
      if (location.origin !== origin) return;
      if (location.hash === '#/' || location.hash === '' || location.hash.startsWith('#/authentication')) {
        sessionStorage.setItem(key, 'E2E-QC721 hold the sign-in page');
      }
    }, { key: SIGN_IN_ERROR_KEY, origin: new URL(env.appUrl ?? 'http://localhost').origin });
    const page = await context.newPage();
    const settings = page.waitForResponse((r) => r.url().includes('/api/setting/public/company-settings') && r.ok());
    await page.goto('/#/');
    await settings;
    const screen = new HostSignInScreen(context, page);
    await expect(page).toHaveURL(/#\/authentication/);
    await expect(screen.heading).toHaveText('Sign In');
    await expect(screen.errorBox).toBeVisible();
    return screen;
  }

  async publicLoginSubtitle(): Promise<string | null | undefined> {
    const url = `${env.appApiUrl}/api/setting/public/company-settings`;
    const body = await this.page.evaluate(async (target) => (await fetch(target)).json(), url);
    return body?.data?.loginSubtitle;
  }

  async close(): Promise<void> {
    await this.page.evaluate((key) => sessionStorage.removeItem(key), SIGN_IN_ERROR_KEY).catch(() => undefined);
    await this.context.close();
  }
}

export class CompanySettingsPage {
  readonly heading: Locator;
  readonly save: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Company Settings' }).first();
    this.save = page.locator('.btn-box button', { hasText: 'Save' });
  }

  async open(): Promise<void> {
    const loaded = this.page.waitForResponse((r) => r.url().includes('/api/setting/host-setting') && r.request().method() === 'GET');
    await this.page.goto('/#/admin/settings');
    expect((await loaded).status(), 'GET host-setting').toBe(200);
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
    await expect(this.save).toBeEnabled();
  }

  async formState(): Promise<{ valid: boolean; invalid: string[]; value: HostSettingsModel }> {
    return this.page.evaluate(() => {
      const ng = (window as unknown as { ng?: { getComponent(el: Element): any } }).ng;
      const host = document.querySelector('app-settings');
      if (!ng || !host) throw new Error('Angular dev-mode debug API is not available on Company Settings.');
      const form = ng.getComponent(host).formGroupModel;
      const invalid = Object.keys(form.controls).filter((name) => form.controls[name].invalid);
      return { valid: form.valid, invalid, value: form.getRawValue() };
    });
  }

  async saveAndWait(): Promise<{ status: number; sent: HostSettingsModel }> {
    const posted = this.page
      .waitForResponse((r) => r.url().includes('/api/setting/host-setting') && r.request().method() === 'POST', { timeout: 10_000 })
      .catch(() => null);
    await this.save.click();
    const response = await posted;
    if (!response) {
      const invalid = await this.page
        .locator('.ng-invalid[formcontrolname], .ng-invalid[ng-reflect-name]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('formcontrolname') ?? e.getAttribute('ng-reflect-name')));
      const messages = await this.page.locator('mat-error, .invalid-feedback, .text-danger').allInnerTexts();
      throw new Error(`Company Settings did not save. Invalid controls: ${invalid.join(', ') || 'none found'}. Messages: ${messages.join(' | ') || 'none'}`);
    }
    return { status: response.status(), sent: response.request().postDataJSON() as HostSettingsModel };
  }
}
