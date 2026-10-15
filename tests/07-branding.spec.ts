import { test, expect } from '../fixtures/test';
import { BrandingPage, HostOverviewPage } from '../pages/HostPages';

test.describe('Sign-in branding (Host settings)', () => {
  test('BRAND-00 branding lives in Host settings and takes its logo from the uploaded images', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const branding = new BrandingPage(page);
    await branding.open(targetHost.uuid);
    await expect(page.locator('#tab-settings')).toHaveClass(/active/);
    await expect(branding.form.locator('input[name$="LogoUrl"], input[name$="FaviconUrl"]')).toHaveCount(0);
    await expect(page.locator('#branding-assets')).toContainText('Sign-in logo');
  });

  test('BRAND-01 the preview follows the colour and name as you type', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const branding = new BrandingPage(page);
    await branding.open(targetHost.uuid);

    await branding.primaryColor.fill('#123456');
    await expect.poll(() => branding.previewBrandColor()).toBe('#123456');

    await branding.displayName.fill('E2E Preview Name');
    await expect(page.locator('[data-preview-name]')).toHaveText('E2E Preview Name');
  });

  test('BRAND-02 an invalid colour is rejected by the server', { tag: '@write' }, async ({ page, targetHost }) => {
    const branding = new BrandingPage(page);
    await branding.open(targetHost.uuid);

    await branding.primaryColor.fill('#12');
    await branding.save.click();

    await expect(page.locator('.qc-error', { hasText: 'Use a hex colour' })).toBeVisible();
  });

  test('BRAND-03 saving branding pushes it to Identity and can be restored', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const branding = new BrandingPage(page);
    await branding.open(targetHost.uuid);
    const original = await branding.primaryColor.inputValue();
    const probe = original.toLowerCase() === '#8b2e16' ? '#1e5631' : '#8b2e16';

    try {
      await branding.primaryColor.fill(probe);
      await branding.save.click();
      await shell.expectStatus(/Sign-in branding saved\. Pushed to live/);

      await branding.open(targetHost.uuid);
      await expect(branding.primaryColor).toHaveValue(probe);

      const overview = new HostOverviewPage(page);
      await overview.open(targetHost.uuid);
      expect(await overview.driftOf('Branding')).toBe('in-sync');
    } finally {
      await branding.open(targetHost.uuid);
      if ((await branding.primaryColor.inputValue()) !== original) {
        await branding.primaryColor.fill(original);
        await branding.save.click();
        await shell.expectStatus(/Sign-in branding saved/);
      }
    }
  });
});
