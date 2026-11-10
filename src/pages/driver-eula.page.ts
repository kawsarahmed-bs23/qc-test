import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '@config/env.config';
import { IdentityLoginPage } from '@pages/identity-login.page';
import { BasePage } from './base.page';

/** The Driver UI's EULA page (QC-909): `/#/eula`, which the eulaGuard sends a driver to until they accept. */
export class DriverEulaPage extends BasePage {
  protected readonly path = '/#/eula';
  readonly text: Locator;
  readonly accept: Locator;
  readonly decline: Locator;

  constructor(page: Page) {
    super(page);
    this.text = page.locator('#eula-text');
    this.accept = page.locator('#eula-accept');
    this.decline = page.locator('#eula-decline');
  }

  async signIn(driver: Credentials): Promise<void> {
    await this.page.goto(driverUiUrl());
    await new IdentityLoginPage(this.page).signIn(driver);
  }

  async expectShown(): Promise<void> {
    await expect(this.page).toHaveURL(/#\/eula$/, { timeout: 30_000 });
    await expect(this.text).toBeVisible();
  }

  async expectTextNames(name: string): Promise<void> {
    await expect(this.text).toContainText(name);
    await expect(this.text).not.toContainText('{{HostName}}');
  }

  async expectPastTheEula(): Promise<void> {
    await expect(this.page).toHaveURL(/#\/(hosts|no-host)?$/, { timeout: 30_000 });
    await expect(this.text).toBeHidden();
  }
}

/** A signed-out browser context for the Driver UI, so the run's Admin or host-app session is not reused at Identity. */
export async function newDriverUiSession(browser: Browser): Promise<{ context: BrowserContext; eula: DriverEulaPage }> {
  const context = await browser.newContext({ baseURL: driverUiUrl(), ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
  return { context, eula: new DriverEulaPage(await context.newPage()) };
}

export function driverUiUrl(): string {
  if (!env.driverUiClient) throw new Error('DRIVER_UI_CLIENT_ID / DRIVER_UI_REDIRECT_URI are not set.');
  return env.driverUiClient.redirectUri;
}
