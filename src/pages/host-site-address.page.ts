import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { authorizeUrl } from '@pages/host-sign-in-flow.page';
import { escape } from '@pages/identity-login.page';
import { BasePage } from './base.page';

export const WRONG_SITE_ADDRESS = '127.0.0.1:7026';

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

  constructor(page: Page) {
    super(page);
    this.subtitle = page.locator('.daxa-form .title p');
    this.termsLink = page.locator('.or a', { hasText: 'Terms' });
    this.privacyLink = page.locator('.or a', { hasText: 'Privacy' });
    this.completeLoginLink = page.locator('#invite-host-sign-in a');
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

  async expectFooterLinks(siteUrl: string): Promise<void> {
    await expect(this.termsLink).toHaveAttribute('href', `${siteUrl}#/legal/terms`);
    await expect(this.privacyLink).toHaveAttribute('href', `${siteUrl}#/legal/privacy`);
  }

  async expectCompleteLoginLink(siteUrl: string): Promise<void> {
    await expect(this.completeLoginLink).toHaveAttribute('href', siteUrl);
    await expect(this.completeLoginLink).toHaveText(siteUrl);
  }
}
