import { expect, type Locator, type Page } from '@playwright/test';
import { BasePage } from './base.page';

export const JOB_DRAFT_PREFIX = 'qc_job_draft';

export class JobDraftPage extends BasePage {
  protected readonly path = '/#/jobs/job-add';
  readonly customerPo: Locator;
  readonly cancel: Locator;
  readonly restoreDialog: Locator;
  readonly restore: Locator;
  readonly discard: Locator;

  constructor(page: Page) {
    super(page);
    this.customerPo = page.locator('input[formcontrolname="customerPO"]');
    this.cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    this.restoreDialog = page.locator('mat-dialog-container').filter({ hasText: 'Restore your unsaved Job?' });
    this.restore = this.restoreDialog.getByRole('button', { name: 'Restore', exact: true });
    this.discard = this.restoreDialog.getByRole('button', { name: 'Discard', exact: true });
  }

  async open(): Promise<void> {
    await this.page.goto(this.path);
  }

  async reload(): Promise<void> {
    await this.page.reload();
  }

  async expectFormReady(): Promise<void> {
    await expect(this.customerPo).toBeVisible({ timeout: 30_000 });
    await expect(this.cancel).toBeEnabled({ timeout: 30_000 });
  }

  async typeCustomerPo(value: string): Promise<void> {
    await this.customerPo.fill(value);
    await this.customerPo.press('Tab');
  }

  draftKeys(): Promise<string[]> {
    return this.page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(`${prefix}:`)), JOB_DRAFT_PREFIX);
  }

  draftText(): Promise<string> {
    return this.page.evaluate((prefix) => {
      const key = Object.keys(localStorage).find((name) => name.startsWith(`${prefix}:`) && name.endsWith(':new'));
      return key ? localStorage.getItem(key)! : '';
    }, JOB_DRAFT_PREFIX);
  }

  clearDrafts(): Promise<void> {
    return this.page.evaluate((prefix) => {
      for (const key of Object.keys(localStorage)) if (key.startsWith(`${prefix}:`)) localStorage.removeItem(key);
    }, JOB_DRAFT_PREFIX);
  }
}
