import { test, expect } from '../fixtures/test';
import { HostOverviewPage, LOGO_TYPES, SettingsPage } from '../pages/HostPages';

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('Host settings', () => {
  test('SET-01 settings match the host app: company, address, email, S3, OCR, QuickBooks, chart of accounts, images, branding', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);

    for (const section of ['company', 'address', 'email', 's3', 'ocr', 'quickbooks', 'chart-of-accounts', 'images']) {
      await expect(settings.section(section)).toBeVisible();
    }
    await expect(page.locator('#sign-in-branding')).toBeVisible();

    for (const name of ['OrganisationName', 'HostUrl', 'HostPublicUrl', 'Address.Address1', 'Address.City', 'Address.Zip', 'Address.Phone', 'S3BucketName', 'S3Region', 'Prefix', 'OCRUrl', 'QBClientId', 'QBCOGSAccountId']) {
      await expect(settings.field(name)).toBeVisible();
    }
    expect(await settings.field('Address.State').locator('option').count()).toBeGreaterThan(1);
    await expect(settings.field('SalesToEmailUserId')).toHaveJSProperty('tagName', 'SELECT');
    await expect(settings.field('SendAsEmailUserId')).toHaveJSProperty('tagName', 'SELECT');
  });

  test('SET-02 secrets are write-only: masked inputs that never carry the stored value', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);

    for (const name of ['NewS3AccessKey', 'NewS3SecretKey', 'NewQBClientSecret']) {
      await expect(settings.field(name)).toHaveAttribute('type', 'password');
      await expect(settings.field(name)).toHaveValue('');
    }
    await expect(page.locator('#managed-externally')).toHaveCount(0);
  });

  test('SET-03 Save stays disabled until something changes', async ({ page, targetHost }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);
    await expect(settings.save).toBeDisabled();
    const original = await settings.field('S3Region').inputValue();
    await settings.field('S3Region').fill(`${original}x`);
    await expect(settings.save).toBeEnabled();
    await settings.field('S3Region').fill(original);
    await expect(settings.save).toBeDisabled();
  });

  test('SET-04 the host API rejects an invalid zip and nothing is saved', { tag: '@write' }, async ({ page, targetHost }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);
    const original = await settings.field('Address.Zip').inputValue();

    await settings.field('Address.Zip').fill('not-a-zip');
    await settings.save.click();

    await expect(page.locator('#settings-errors')).toContainText('Nothing was saved');
    await expect(settings.field('Address.Zip')).toHaveClass(/qc-invalid/);
    await expect(settings.save).toBeEnabled();

    await settings.open(targetHost.uuid);
    await expect(settings.field('Address.Zip')).toHaveValue(original);
  });

  test('SET-05 saving a setting goes through the host API, refreshes HOST_MASTER and can be restored', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);
    test.skip(!(await settings.field('Address.Address1').inputValue()), 'The host has no billing address yet; the host app requires Address 1 before any save.');

    const original = await settings.field('Prefix').inputValue();
    const probe = original === 'E2E' ? 'E2E2' : 'E2E';

    try {
      await settings.field('Prefix').fill(probe);
      await settings.save.click();
      await shell.expectStatus('Host settings saved.');

      await settings.open(targetHost.uuid);
      await expect(settings.field('Prefix')).toHaveValue(probe);

      const overview = new HostOverviewPage(page);
      await overview.open(targetHost.uuid);
      expect(await overview.driftOf('HostSettings')).toBe('in-sync');
    } finally {
      await settings.open(targetHost.uuid);
      if ((await settings.field('Prefix').inputValue()) !== original) {
        await settings.field('Prefix').fill(original);
        await settings.save.click();
        await shell.expectStatus('Host settings saved.');
      }
    }
  });

  test('SET-06 every logo has a preview and an upload control; choosing a file previews it before upload', async ({ page, targetHost }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);

    for (const type of LOGO_TYPES) {
      const card = settings.logoCard(type);
      await expect(card.locator('.qc-logo-preview')).toBeVisible();
      await expect(card.locator('[data-logo-choose]')).toBeVisible();
      await expect(card.locator('[data-logo-file]')).toHaveAttribute('accept', /\.png/);
    }
    await expect(settings.logoCard('logo-icon').locator('[data-logo-file]')).toHaveAttribute('accept', /\.ico/);

    const card = settings.logoCard('logo-main');
    await card.locator('[data-logo-file]').setInputFiles({ name: 'e2e.png', mimeType: 'image/png', buffer: TINY_PNG });
    await expect(card).toHaveClass(/qc-logo-pending/);
    await expect(card.locator('[data-logo-image]')).toHaveAttribute('src', /^blob:/);
    await expect(card.locator('[data-logo-submit]')).toBeVisible();

    await card.locator('[data-logo-cancel]').click();
    await expect(card).not.toHaveClass(/qc-logo-pending/);
    await expect(card.locator('[data-logo-submit]')).toBeHidden();
  });

  test('SET-07 a logo can be uploaded and deleted', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const settings = new SettingsPage(page);
    await settings.open(targetHost.uuid);

    let free: (typeof LOGO_TYPES)[number] | undefined;
    for (const type of LOGO_TYPES) {
      if ((await settings.logoCard(type).locator('[data-logo-delete]').count()) === 0) {
        free = type;
        break;
      }
    }
    test.skip(!free, 'Every logo is already set; this test only uses an empty slot so it can restore it.');

    const card = settings.logoCard(free!);
    await card.locator('[data-logo-file]').setInputFiles({ name: 'e2e.png', mimeType: 'image/png', buffer: TINY_PNG });
    await card.locator('[data-logo-submit]').click();
    await shell.expectStatus(/uploaded/);
    await expect(card.locator('[data-logo-image]')).toBeVisible();
    await expect(card.locator('[data-logo-delete]')).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await card.locator('[data-logo-delete]').click();
    await shell.expectStatus(/deleted/);
    await expect(card.locator('[data-logo-delete]')).toHaveCount(0);
    await expect(card.locator('[data-logo-empty]')).toContainText('No image');
  });

  test('SET-08 the overview refreshes host settings from live instead of pushing them', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const overview = new HostOverviewPage(page);
    await overview.open(targetHost.uuid);

    const button = overview.areaRow('HostSettings').locator('[data-sync-area]');
    await expect(button).toContainText('Refresh');
    await button.click();
    await shell.expectStatus('Host settings refreshed from live.');
    expect(await overview.driftOf('HostSettings')).toBe('in-sync');
  });
});
