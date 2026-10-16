import { test, expect } from '../fixtures/test';
import { HostEnvironmentPage, HostFeaturesPage } from '../pages/HostManagementPages';
import { env } from '../config/environment';

const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';

test.describe('Activity log (QC-737)', () => {
  test('ACT-01 switching a feature records a Features entry that names the Admin user', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.feature('maps').isChecked();

    try {
      await features.feature('maps').setChecked(!original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change.');

      await page.goto(`/activity?host=${targetHost.uuid}`);
      const latest = page.locator('#activity-list li').first();
      await expect(latest).toHaveAttribute('data-activity-area', 'Features');
      await expect(latest.locator('.qc-activity-text')).toHaveText(original ? 'Switched off Maps' : 'Switched on Maps');
      await expect(latest.locator('.qc-activity-meta')).toContainText(env.admin!.email);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.feature('maps').isChecked()) !== original) {
        await features.feature('maps').setChecked(original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }
  });

  test('ACT-02 an environment save records the key and never the value', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const probe = original === '4321' ? '4322' : '4321';

    try {
      await environment.input(SAFE_SETTING).fill(probe);
      await environment.save.click();
      await shell.expectStatus('Saved 1 setting.');

      await page.goto(`/activity?host=${targetHost.uuid}`);
      const latest = page.locator('#activity-list li').first();
      await expect(latest).toHaveAttribute('data-activity-area', 'Environment');
      await expect(latest.locator('.qc-activity-text')).toHaveText(`Changed ${SAFE_SETTING}`);
      await expect(latest).not.toContainText(probe);
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.input(SAFE_SETTING).fill(original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.');
      }
    }
  });

  test('ACT-03 the dashboard shows the latest change at the top of Recent activity', async ({ page }) => {
    await page.goto('/activity');
    const newest = page.locator('#activity-list li .qc-activity-text').first();
    if ((await newest.count()) === 0) {
      test.skip(true, 'No changes recorded yet.');
    }
    const text = await newest.innerText();
    await page.goto('/');
    await expect(page.locator('#activity-list li .qc-activity-text').first()).toHaveText(text);
  });

  test('ACT-04 the user menu signs out through Identity', async ({ page, shell }) => {
    await page.goto('/');
    await shell.signOut();
    await expect(page).toHaveURL(new RegExp(`^${env.identityUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });
});
