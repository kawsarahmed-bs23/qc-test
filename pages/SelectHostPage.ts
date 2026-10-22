import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { escape, IdentityLoginPage } from './IdentityLoginPage';
import type { Credentials } from '../config/environment';

export const SELECT_HOST_HEADING = 'Choose a host';
export const SELECT_HOST_INVALID = 'Choose one of the hosts in the list.';
export const NO_HOST_HEADING = 'No host available';

export class SelectHostPage {
  readonly heading: Locator;
  readonly list: Locator;
  readonly options: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.locator('#page-heading');
    this.list = page.locator('ul#host-list');
    this.options = this.list.locator('button.qc-host-option[data-host-uuid]');
    this.error = page.locator('.custom-error-message[role="alert"]');
  }

  option(hostUuid: string): Locator {
    return this.list.locator(`button.qc-host-option[data-host-uuid="${hostUuid}" i]`);
  }

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/SelectHost`, 'i'));
    await expect(this.heading).toHaveText(SELECT_HOST_HEADING);
  }

  async hostUuids(): Promise<string[]> {
    const values = await this.options.evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-host-uuid') ?? ''));
    return values.map((v) => v.toLowerCase()).sort();
  }

  async choose(hostUuid: string): Promise<void> {
    await this.option(hostUuid).click();
  }

  async chooseUnlisted(hostUuid: string): Promise<void> {
    const first = this.options.first();
    await first.evaluate((button, value) => button.setAttribute('value', value), hostUuid);
    await first.click();
  }
}

export class NoHostPage {
  readonly heading: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.locator('#page-heading');
  }

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/NoHost`, 'i'));
    await expect(this.heading).toHaveText(NO_HOST_HEADING);
  }
}

export class IdentityRootLanding {
  private landedOn: string | null = null;

  constructor(private readonly page: Page) {}

  async signIn(credentials: Credentials): Promise<void> {
    this.page.on('request', (request) => {
      if (!this.landedOn && request.isNavigationRequest() && request.frame() === this.page.mainFrame() && !request.url().startsWith(env.identityUrl)) {
        this.landedOn = request.url();
      }
    });
    await this.page.goto(`${env.identityUrl}/`);
    await new IdentityLoginPage(this.page).signIn(credentials);
  }

  async expectLandedOn(url: string): Promise<void> {
    await expect.poll(() => this.landedOn, { message: `redirect to ${url}`, timeout: 30_000 }).toBe(url);
  }

  landed(): string | null {
    return this.landedOn;
  }
}
