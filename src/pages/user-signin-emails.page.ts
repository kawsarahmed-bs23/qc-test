import { devices, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { IdentityLoginPage } from '@pages/identity-login.page';
import { openIdentitySignInFromApp } from '@pages/user-eula.page';
import type { UserArea } from '@api/user-invites.api';

const LOG_DATE = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/;

function isEmailLogGet(method: string, url: string): boolean {
  return method === 'GET' && /\/user-edit\/[^/]+\/email-log$/i.test(new URL(url).pathname);
}

function isPasswordResetPost(method: string, url: string): boolean {
  return method === 'POST' && /\/user-edit\/[^/]+\/password-reset$/i.test(new URL(url).pathname);
}

/** QC-1008: the Send Password Reset button and the Sign-in emails log inside `#user-signin-section` of Edit User and the Vendor Portal user page. */
export class UserSigninEmailsSection {
  readonly section: Locator;
  readonly send: Locator;
  readonly result: Locator;
  readonly log: Locator;
  readonly items: Locator;
  readonly texts: Locator;
  readonly dates: Locator;
  readonly empty: Locator;
  readonly identityUnavailable: Locator;
  readonly errorToast: Locator;
  readonly successToast: Locator;
  readonly inviteSend: Locator;

  constructor(private readonly page: Page) {
    this.section = page.locator('#user-signin-section');
    this.send = this.section.locator('#user-password-reset-send');
    this.result = this.section.locator('#user-password-reset-result');
    this.log = this.section.locator('#user-email-log');
    this.items = this.log.locator('.user-email-log__item');
    this.texts = this.log.locator('.user-email-log__text');
    this.dates = this.log.locator('.user-email-log__at');
    this.empty = this.log.locator('#user-email-log-empty');
    this.identityUnavailable = this.log.locator('#user-email-log-identity-unavailable');
    this.errorToast = page.locator('.error-snackbar');
    this.successToast = page.locator('.success-snackbar');
    this.inviteSend = this.section.locator('#user-invite-send');
  }

  async expectSendButton(): Promise<void> {
    await expect(this.send).toBeVisible();
    await expect(this.send).toBeEnabled();
    await expect(this.send).toHaveText('Send Password Reset');
  }

  async expectNoSendButton(): Promise<void> {
    await expect(this.log).toBeVisible();
    await expect(this.send).toHaveCount(0);
  }

  /** Presses Send Password Reset and returns the status of the POST .../password-reset. */
  async pressSend(): Promise<number> {
    const posted = this.page.waitForResponse((r) => isPasswordResetPost(r.request().method(), r.url()));
    await this.send.click();
    return (await posted).status();
  }

  async expectResult(sent: boolean, message: string): Promise<void> {
    await expect(this.result).toHaveAttribute('data-sent', String(sent));
    await expect(this.result).toHaveText(message);
  }

  /** The log lines, newest first, exactly. */
  async expectLines(lines: string[]): Promise<void> {
    await expect(this.texts).toHaveText(lines);
    await expect(this.items).toHaveCount(lines.length);
    await expect(this.empty).toHaveCount(0);
  }

  async expectKinds(kindsAndOutcomes: string[]): Promise<void> {
    const pairs = await this.items.evaluateAll((nodes) => nodes.map((n) => `${n.getAttribute('data-kind')}/${n.getAttribute('data-outcome')}`));
    expect(pairs).toEqual(kindsAndOutcomes);
  }

  async expectDatesFormatted(): Promise<string[]> {
    const dates = (await this.dates.allInnerTexts()).map((d) => d.trim());
    for (const date of dates) expect(date).toMatch(LOG_DATE);
    return dates;
  }

  async expectEmpty(): Promise<void> {
    await expect(this.empty).toHaveText('No sign-in emails yet.');
    await expect(this.items).toHaveCount(0);
  }

  /** Waits for the next GET .../email-log the page makes and returns its status (the log reloads after a send). */
  waitForLogReload(): Promise<number> {
    return this.page.waitForResponse((r) => isEmailLogGet(r.request().method(), r.url())).then((r) => r.status());
  }
}

/** A signed-out browser that reaches Identity's own Forgot Password and Email me a sign-in link pages from the host's "Sign in with QuarryConnect". */
export class SignedOutEmailRequests {
  private forgotUrl: string | null = null;
  private magicUrl: string | null = null;
  readonly login: IdentityLoginPage;
  readonly email: Locator;
  readonly submit: Locator;

  private constructor(
    readonly context: BrowserContext,
    readonly page: Page,
  ) {
    this.login = new IdentityLoginPage(page);
    this.email = page.locator('#Input_Email');
    this.submit = page.locator('form[method="post"] button[type="submit"]');
  }

  static async open(browser: Browser): Promise<SignedOutEmailRequests> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      viewport: { width: 1440, height: 900 },
      storageState: { cookies: [], origins: [] },
    });
    return new SignedOutEmailRequests(context, await context.newPage());
  }

  /** Host app > Sign in with QuarryConnect, so Identity knows the client (host.local), then Forgot password. */
  async openForgotPassword(): Promise<void> {
    await openIdentitySignInFromApp(this.page);
    await this.login.expectVisible();
    await this.page.locator('a[href*="/Account/ForgotPassword"]').click();
    await expect(this.page).toHaveURL(/\/Account\/ForgotPassword/i);
    this.forgotUrl = this.page.url();
  }

  async requestReset(email: string): Promise<void> {
    await this.page.goto(this.forgotUrl!);
    await this.email.fill(email);
    await this.submit.click();
    await expect(this.page).toHaveURL(/\/Account\/ForgotPasswordConfirmation/i);
  }

  async openMagicLink(): Promise<void> {
    await openIdentitySignInFromApp(this.page);
    await this.login.expectVisible();
    await this.page.locator('#magic-link').click();
    await expect(this.page).toHaveURL(/\/Account\/MagicLink/i);
    this.magicUrl = this.page.url();
  }

  async requestSignInLink(email: string): Promise<void> {
    await this.page.goto(this.magicUrl!);
    await this.email.fill(email);
    await this.submit.click();
    await expect(this.page).toHaveURL(/\/Account\/MagicLinkSent/i);
  }

  async close(): Promise<void> {
    await this.context.close();
  }
}

export type { UserArea };
