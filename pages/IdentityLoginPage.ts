import { expect, type Locator, type Page } from '@playwright/test';
import { env, type Credentials } from '../config/environment';
import { markIdentityLog, resetLinkSince } from '../fixtures/identityLog';

export class IdentityLoginPage {
  readonly email: Locator;
  readonly password: Locator;
  readonly submit: Locator;

  constructor(private readonly page: Page) {
    this.email = page.locator('input[type="email"]');
    this.password = page.locator('input[type="password"]');
    this.submit = page.locator('form').filter({ has: this.password }).getByRole('button', { name: /^sign in$/i });
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

  async resetExpectingInvalidLink(link: string, password: string): Promise<void> {
    await this.page.goto(link);
    await this.page.locator('#Input_Password').fill(password);
    await this.page.locator('#Input_ConfirmPassword').fill(password);
    await this.page.locator('form[method="post"] button[type="submit"]').click();
    await expect(this.page.locator('.custom-error-message[role="alert"]')).toBeVisible();
    await expect(this.page).not.toHaveURL(/\/Account\/ResetPasswordConfirmation/i);
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
