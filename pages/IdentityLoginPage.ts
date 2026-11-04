import { expect, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '../config/environment';
import { markIdentityLog, resetLinkSince } from '../fixtures/identityLog';
import { currentStep, secondsLeftInStep, totp } from '../fixtures/totp';

const lastStepUsed = new Map<string, number>();

export class IdentityLoginPage {
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;
  readonly submitAnyLanguage: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.email = page.locator('input[type="email"]');
    this.password = page.locator('input[type="password"]');
    this.submit = page.locator('form').filter({ has: this.password }).getByRole('button', { name: /^sign in$/i });
    this.submitAnyLanguage = page.locator('form').filter({ has: this.password }).locator('button[type="submit"]');
    this.error = page.locator('.custom-error-message[role="alert"]:not([hidden])');
  }

  async open(returnUrl?: string): Promise<void> {
    const query = returnUrl ? `?ReturnUrl=${encodeURIComponent(returnUrl)}` : '';
    await this.page.goto(`${env.identityUrl}/Account/Login${query}`);
    await this.expectVisible();
  }

  async submitOnce(credentials: Credentials): Promise<void> {
    await this.expectVisible();
    await this.email.fill(credentials.email);
    await this.password.fill(credentials.password);
    await Promise.all([
      this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/Account\/Login/i.test(new URL(r.url()).pathname)),
      this.submitAnyLanguage.click(),
    ]);
    await this.page.waitForLoadState('domcontentloaded');
  }

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/Login`, 'i'));
    await expect(this.email).toBeVisible();
    await expect(this.password).toBeVisible();
  }

  async signIn(credentials: Credentials): Promise<void> {
    await this.expectVisible();
    await this.email.fill(credentials.email);
    await this.password.fill(credentials.password);
    await this.submit.click();
  }

  async signInWithTwoStep(credentials: Credentials, authenticatorKey: string): Promise<void> {
    await this.signIn(credentials);
    await new IdentityTwoStepPage(this.page).verify(authenticatorKey);
  }
}

export class IdentityBrandingView {
  readonly logo: Locator;
  readonly favicon: Locator;
  readonly subtitle: Locator;
  readonly background: Locator;

  constructor(private readonly page: Page) {
    this.logo = page.locator('.daxa-form .title .logo img');
    this.favicon = page.locator('head link[rel="icon"]');
    this.subtitle = page.locator('.daxa-form .title p');
    this.background = page.locator('.qc-host-background');
  }

  async logoLoaded(): Promise<boolean> {
    return this.logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  }

  async backgroundImageUrl(): Promise<string | null> {
    const style = await this.background.getAttribute('style');
    return style?.match(/background-image:\s*url\('([^']+)'\)/)?.[1] ?? null;
  }
}

export class IdentityTwoStepPage {
  readonly code: Locator;
  readonly digits: Locator;
  readonly submit: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.code = page.locator('#Input_Code');
    this.error = page.locator('.custom-error-message[role="alert"]:not([hidden])');
    this.digits = page.getByRole('textbox', { name: /^Digit \d of 6$/ });
    this.submit = page.locator('form[method="post"] button[type="submit"]');
  }

  async expectVisible(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/LoginWith2fa`, 'i'));
    await expect(this.digits).toHaveCount(6);
  }

  async submitCode(code: string): Promise<void> {
    await this.expectVisible();
    const posted = this.page.waitForResponse((r) => r.request().method() === 'POST' && /\/Account\/LoginWith2fa/i.test(new URL(r.url()).pathname));
    for (let i = 0; i < code.length; i++) {
      await this.digits.nth(i).fill(code[i]);
    }
    const autoSubmitted = await Promise.race([posted.then(() => true), this.page.waitForTimeout(3_000).then(() => false)]);
    if (!autoSubmitted) {
      await Promise.all([posted, this.submit.click()]);
    }
    await this.page.waitForLoadState('domcontentloaded');
  }

  async expectEnrolment(): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`^${escape(env.identityUrl)}/Account/EnableAuthenticator`, 'i'));
  }

  async verify(authenticatorKey: string): Promise<void> {
    await this.expectVisible();
    if (secondsLeftInStep() < 3 || lastStepUsed.get(authenticatorKey) === currentStep()) {
      await this.page.waitForTimeout(secondsLeftInStep() * 1000 + 250);
    }
    lastStepUsed.set(authenticatorKey, currentStep());
    const code = totp(authenticatorKey);
    for (let i = 0; i < code.length - 1; i++) {
      await this.digits.nth(i).fill(code[i]);
    }
    await expect(this.code).toHaveValue(code.slice(0, -1));
    await this.digits.last().fill(code.at(-1)!);
    const submitted = await this.page
      .waitForURL((url) => !/\/Account\/LoginWith2fa/i.test(url.pathname), { timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!submitted) {
      await this.submit.click();
    }
  }
}

export class IdentityLogoutPage {
  readonly signOut: Locator;

  constructor(private readonly page: Page) {
    this.signOut = page.locator('form[method="post"] button[type="submit"]');
  }

  async expectSignedIn(): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/Logout`);
    await expect(this.signOut).toBeVisible();
  }

  async expectSignedOut(): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/Logout`);
    await new IdentityLoginPage(this.page).expectVisible();
  }

  async signOutHere(): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/Logout`);
    await this.signOut.click();
    await new IdentityLoginPage(this.page).expectVisible();
  }
}

export class IdentityPasswordResetPage {
  constructor(private readonly page: Page) {}

  async requestReset(email: string): Promise<void> {
    await this.page.goto(`${env.identityUrl}/Account/ForgotPassword`);
    await this.page.locator('#Input_Email').fill(email);
    await this.page.locator('form[method="post"] button[type="submit"]').click();
    await expect(this.page).toHaveURL(/\/Account\/ForgotPasswordConfirmation/i);
  }

  async requestLink(email: string): Promise<string> {
    const mark = markIdentityLog();
    await this.requestReset(email);
    let link: string | null = null;
    await expect.poll(() => (link = resetLinkSince(mark, email)), { message: 'reset link in the Identity log' }).not.toBeNull();
    return link!;
  }

  async resetVia(email: string, password: string): Promise<string> {
    const link = await this.requestLink(email);
    await this.resetTo(link, password);
    return link;
  }

  async expectInvalidLink(link: string): Promise<void> {
    await this.page.goto(link);
    await expect(this.page.locator('.custom-error-message[role="alert"]')).toBeVisible();
    await expect(this.page.locator('#Input_Password')).toHaveCount(0);
    await expect(this.page.locator('a[href="/Account/ForgotPassword"]')).toBeVisible();
  }

  async resetTo(link: string, password: string): Promise<void> {
    await this.page.goto(link);
    await this.page.locator('#Input_Password').fill(password);
    await this.page.locator('#Input_ConfirmPassword').fill(password);
    await this.page.locator('form[method="post"] button[type="submit"]').click();
    await expect(this.page).toHaveURL(/\/Account\/ResetPasswordConfirmation/i);
  }
}

export function escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
