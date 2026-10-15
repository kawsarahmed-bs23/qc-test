import { expect, type Locator, type Page } from '@playwright/test';

export class AdminShell {
  readonly heading: Locator;
  readonly snackBar: Locator;
  readonly profileMenuButton: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.locator('#page-heading');
    this.snackBar = page.locator('#status-message, [data-status]').first();
    this.profileMenuButton = page.locator('#profile-menu-button');
  }

  nav(name: 'dashboard' | 'hosts' | 'activity' | 'users'): Locator {
    return this.page.locator(`#nav-${name}`);
  }

  async expectStatus(text: string | RegExp): Promise<void> {
    await expect(this.snackBar).toBeVisible();
    await expect(this.snackBar).toContainText(text);
  }

  async signOut(): Promise<void> {
    await this.profileMenuButton.click();
    await this.page.locator('#sign-out').click();
  }
}
