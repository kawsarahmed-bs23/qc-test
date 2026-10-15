import { test, expect } from '../fixtures/test';
import { FeaturesPage, HostOverviewPage } from '../pages/HostPages';

test.describe('Feature switches', () => {
  test('FEAT-00 the features page has no summary cards', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const features = new FeaturesPage(page);
    await features.open(targetHost.uuid);
    await expect(page.locator('.qc-kpi, .qc-kpi-grid')).toHaveCount(0);
    await expect(page.locator('[data-group]')).toHaveCount(2);
  });

  test('FEAT-01 QuickBooks and SAGE together shows a warning and blocks Save', async ({ page, targetHost }) => {
    const features = new FeaturesPage(page);
    await features.open(targetHost.uuid);

    await features.setOn('quickbooks', true);
    await features.setOn('sage', true);

    await expect(features.warning('quickbooks').or(features.warning('sage')).first()).toBeVisible();
    await expect(features.save).toBeDisabled();
  });

  test('FEAT-02 Statewide dispatch without Dispatch shows a warning and blocks Save', async ({ page, targetHost }) => {
    const features = new FeaturesPage(page);
    await features.open(targetHost.uuid);

    await features.setOn('dispatch', false);
    await features.setOn('dispatch_statewide', true);

    await expect(features.warning('dispatch_statewide')).toContainText('Requires Dispatch');
    await expect(features.save).toBeDisabled();
  });

  test('FEAT-03 the server rejects a conflicting set even if the page check is bypassed', { tag: '@write' }, async ({ page, targetHost }) => {
    const features = new FeaturesPage(page);
    await features.open(targetHost.uuid);
    const before = { quickbooks: await features.isOn('quickbooks'), sage: await features.isOn('sage') };

    await features.setOn('quickbooks', true);
    await features.setOn('sage', true);
    await Promise.all([page.waitForLoadState('load'), features.form.evaluate((form: HTMLFormElement) => form.submit())]);

    await expect(features.errors).toContainText('Nothing was saved');
    await expect(features.errors).toContainText('cannot both be enabled');

    await features.open(targetHost.uuid);
    expect(await features.isOn('quickbooks')).toBe(before.quickbooks);
    expect(await features.isOn('sage')).toBe(before.sage);
  });

  test('FEAT-04 switching a feature saves, pushes to live and survives a reload', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new FeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('maps');

    try {
      await test.step('flip Maps and save', async () => {
        await features.setOn('maps', !original);
        await expect(features.saveLabel).toHaveText('Save changes (1)');
        await features.save.click();
        await shell.expectStatus(/feature\(s\) updated\. Pushed to live/);
      });

      await test.step('value persists after reload', async () => {
        await features.open(targetHost.uuid);
        expect(await features.isOn('maps')).toBe(!original);
      });

      await test.step('overview reports Features in sync with live', async () => {
        const overview = new HostOverviewPage(page);
        await overview.open(targetHost.uuid);
        expect(await overview.driftOf('Features')).toBe('in-sync');
      });
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
        await features.save.click();
        await shell.expectStatus(/updated/);
      }
    }
  });
});
