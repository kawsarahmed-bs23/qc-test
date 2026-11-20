import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { authorizeUrl } from '@pages/host-sign-in-flow.page';
import { escape } from '@pages/identity-login.page';
import { BasePage } from './base.page';

export const WRONG_SITE_ADDRESS = '127.0.0.1:7026';

export const LEGAL_LINKS = {
  terms: 'https://www.quarryconnect.com/terms',
  privacy: 'https://www.quarryconnect.com/privacy',
} as const;

const GREY_BORDER = 'rgb(224, 224, 224)';
const WHITE = 'rgb(255, 255, 255)';

export function hostSiteUrl(): string {
  const origin = new URL(env.appUrl!).origin;
  return `${origin}/`;
}

export class HostSiteAddressPage extends BasePage {
  protected readonly path = '/Account/Login';
  readonly subtitle: Locator;
  readonly termsLink: Locator;
  readonly privacyLink: Locator;
  readonly completeLoginLink: Locator;
  readonly card: Locator;
  readonly languageSwitch: Locator;
  readonly english: Locator;
  readonly spanish: Locator;

  constructor(page: Page) {
    super(page);
    this.subtitle = page.locator('.daxa-form .title p');
    this.termsLink = page.locator('.or a', { hasText: /^(Terms|Términos)$/ });
    this.privacyLink = page.locator('.or a', { hasText: /^(Privacy|Privacidad)$/ });
    this.completeLoginLink = page.locator('#invite-host-sign-in a');
    this.card = page.locator('.daxa-form');
    this.languageSwitch = this.card.locator('.qc-language');
    this.english = this.languageSwitch.getByRole('link', { name: 'English', exact: true });
    this.spanish = this.languageSwitch.getByRole('link', { name: 'Español', exact: true });
  }

  async openLoginForHostClient(): Promise<void> {
    const client = env.hostClient!;
    await this.page.goto(authorizeUrl({ client_id: client.clientId, redirect_uri: client.redirectUri }));
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/Login`, 'i'));
    await expect(this.page.locator('input[type="password"]')).toBeVisible();
  }

  async expectContinueTo(domain: string): Promise<void> {
    await expect(this.subtitle).toHaveText(new RegExp(`${escape(domain)}\\s*$`));
    await expect(this.subtitle).not.toContainText(WRONG_SITE_ADDRESS);
  }

  async openPlatformLogin(): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/Login`);
    await expect(this.page.locator('input[type="password"]')).toBeVisible();
  }

  async openForgotPassword(): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/ForgotPassword`);
    await expect(this.card).toBeVisible();
  }

  async expectFooterLinks(): Promise<void> {
    for (const [link, href] of [
      [this.termsLink, LEGAL_LINKS.terms],
      [this.privacyLink, LEGAL_LINKS.privacy],
    ] as const) {
      await expect(link).toHaveAttribute('href', href);
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', /noopener/);
    }
  }

  async expectFlagSwitchInCard(): Promise<void> {
    await expect(this.page.locator('.qc-language')).toHaveCount(1);
    await expect(this.languageSwitch).toBeVisible();
    await expect(this.languageSwitch).not.toHaveCSS('position', 'fixed');
    const tiles = this.languageSwitch.getByRole('link');
    await expect(tiles).toHaveCount(2);
    await expect(tiles).toHaveText(['', '']);
    await expect(tiles.nth(0)).toHaveAccessibleName('English');
    await expect(tiles.nth(1)).toHaveAccessibleName('Español');
    await expect(this.english).toHaveAttribute('title', 'English');
    await expect(this.spanish).toHaveAttribute('title', 'Español');
    await expect(this.english.locator('img')).toHaveAttribute('src', /\/qc-ui\/media\/flag-us(\.\w+)?\.png$/);
    await expect(this.spanish.locator('img')).toHaveAttribute('src', /\/qc-ui\/media\/flag-mx(\.\w+)?\.png$/);
    for (const img of await this.languageSwitch.locator('img').all()) {
      await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0), { message: 'the flag image loads' }).toBe(true);
    }

    const card = (await this.card.boundingBox())!;
    const row = (await this.languageSwitch.boundingBox())!;
    const last = (await this.spanish.boundingBox())!;
    expect(row.y - card.y, 'the flags sit at the top of the card').toBeLessThan(80);
    expect(card.x + card.width - (last.x + last.width), 'the flags sit at the right of the card').toBeLessThan(80);
    const logo = this.card.locator('.title .logo');
    if (await logo.count()) {
      const logoBox = (await logo.boundingBox())!;
      expect(row.y + row.height, 'the flags sit above the logo').toBeLessThanOrEqual(logoBox.y);
    }
  }

  async expectLanguage(language: 'en' | 'es'): Promise<void> {
    const [selected, other] = language === 'en' ? [this.english, this.spanish] : [this.spanish, this.english];
    await expect(this.page.locator('html')).toHaveAttribute('lang', language);
    await expect(selected).toHaveAttribute('aria-current', 'true');
    await expect(other).toHaveAttribute('aria-current', 'false');
    await expect(selected).not.toHaveCSS('border-top-color', GREY_BORDER);
    await expect(selected).not.toHaveCSS('background-color', WHITE);
    await expect(other).toHaveCSS('border-top-color', GREY_BORDER);
    await expect(other).toHaveCSS('background-color', WHITE);
  }

  async expectCompleteLoginLink(siteUrl: string): Promise<void> {
    await expect(this.completeLoginLink).toHaveAttribute('href', siteUrl);
    await expect(this.completeLoginLink).toHaveText(siteUrl);
  }
}
