import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';

export type SnackKind = 'success' | 'error' | 'warning' | 'info';

export function adminUrl(path = '/'): string {
  return `${env.adminUrl}/#${path.startsWith('/') ? path : `/${path}`}`;
}

export async function openAdmin(page: Page, path = '/'): Promise<void> {
  const sameDocument = page.url().startsWith(`${env.adminUrl}/`);
  await page.goto(adminUrl(path));
  if (sameDocument) {
    await page.reload();
  }
}

export async function waitForIdle(page: Page): Promise<void> {
  await expect(page.locator('.loading-shade')).toHaveCount(0);
}

export class ConfirmDialog {
  readonly root: Locator;
  readonly title: Locator;
  readonly message: Locator;
  readonly confirm: Locator;
  readonly cancel: Locator;

  constructor(page: Page) {
    this.root = page.locator('#confirm-dialog');
    this.title = page.locator('#confirm-dialog-title');
    this.message = page.locator('#confirm-dialog-message');
    this.confirm = page.locator('#confirm-dialog-confirm');
    this.cancel = page.locator('#confirm-dialog-cancel');
  }

  async accept(): Promise<void> {
    await expect(this.root).toBeVisible();
    await this.confirm.click();
    await expect(this.root).toHaveCount(0);
  }

  async dismiss(): Promise<void> {
    await expect(this.root).toBeVisible();
    await this.cancel.click();
    await expect(this.root).toHaveCount(0);
  }
}

export class AdminShell {
  readonly heading: Locator;
  readonly pageHeader: Locator;
  readonly breadcrumb: Locator;
  readonly profileMenuButton: Locator;
  readonly userName: Locator;
  readonly userEmail: Locator;
  readonly confirmDialog: ConfirmDialog;
  readonly notFound: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.locator('#page-heading');
    this.pageHeader = page.locator('[data-testid="page-header"]');
    this.breadcrumb = page.locator('[data-testid="breadcrumb"]');
    this.profileMenuButton = page.locator('#profile-menu-button');
    this.userName = page.locator('#header-user-name');
    this.userEmail = page.locator('#header-user-email');
    this.confirmDialog = new ConfirmDialog(page);
    this.notFound = page.locator('#not-found-page');
  }

  nav(name: 'dashboard' | 'hosts' | 'activity' | 'users'): Locator {
    return this.page.locator(`#nav-${name}`);
  }

  snackBar(kind?: SnackKind): Locator {
    return this.page.locator(kind ? `.${kind}-snackbar` : '.global-snackbar').last();
  }

  async expectStatus(text: string | RegExp, kind: SnackKind | 'any' = 'success'): Promise<void> {
    const snack = this.page.locator(kind === 'any' ? '.global-snackbar' : `.${kind}-snackbar`).filter({ hasText: text });
    await expect(snack.first()).toBeVisible();
  }

  async dismissSnackBars(): Promise<void> {
    for (const button of await this.page.locator('.global-snackbar button').all()) {
      await button.click().catch(() => undefined);
    }
    await expect(this.page.locator('.global-snackbar')).toHaveCount(0);
  }

  async expectNotFound(): Promise<void> {
    await expect(this.notFound).toBeVisible();
    await expect(this.heading).toHaveText('Page not found');
  }

  async signOut(): Promise<void> {
    await this.profileMenuButton.click();
    await this.page.locator('#sign-out').click();
  }
}
