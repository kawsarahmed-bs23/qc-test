import { test, expect } from '../fixtures/test';
import { AdminShell } from '../pages/AdminShell';
import { HostEnvironmentPage, HostFeaturesPage } from '../pages/HostManagementPages';
import { ActivityPage, DashboardPage } from '../pages/HostPages';
import { escape } from '../pages/IdentityLoginPage';
import { env } from '../config/environment';

const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';

test.describe('Activity log (QC-737, Angular since QC-742)', () => {
  test('ACT-01 switching a feature records a Features entry that names the Admin user', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('maps');

    try {
      await features.setOn('maps', !original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change.');

      const activity = new ActivityPage(page);
      await activity.open(targetHost.uuid);
      const latest = activity.list.latest;
      await expect(latest).toHaveAttribute('data-activity-area', 'Features');
      await expect(activity.list.text(latest)).toHaveText(original ? 'Switched off Maps' : 'Switched on Maps');
      await expect(activity.list.meta(latest)).toContainText(env.admin!.email);
      await expect(latest.locator('[data-testid="activity-host-link"]')).toHaveText(targetHost.name);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
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
      await shell.expectStatus('Saved 1 setting.', 'warning');

      const activity = new ActivityPage(page);
      await activity.open(targetHost.uuid);
      const latest = activity.list.latest;
      await expect(latest).toHaveAttribute('data-activity-area', 'Environment');
      await expect(activity.list.text(latest)).toHaveText(`Changed ${SAFE_SETTING}`);
      await expect(latest).not.toContainText(probe);
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.input(SAFE_SETTING).fill(original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
      }
    }
  });

  test('ACT-03 the dashboard shows the latest change at the top of Recent activity', async ({ page }) => {
    const activity = new ActivityPage(page);
    await activity.open();
    test.skip((await activity.list.entries.count()) === 0, 'No changes recorded yet.');
    const text = await activity.list.text(activity.list.latest).innerText();

    const dashboard = new DashboardPage(page);
    await dashboard.open();
    await expect(dashboard.activity.text(dashboard.activity.latest)).toHaveText(text);
  });

  test('ACT-04 the user menu signs out through Identity', async ({ browser, page }) => {
    test.skip(!env.admin, 'No admin credentials');
    const context = await browser.newContext({ storageState: await page.context().storageState(), ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const own = await context.newPage();
    try {
      await new DashboardPage(own).open();
      await new AdminShell(own).signOut();
      await expect(own).toHaveURL(new RegExp(`^${escape(env.identityUrl)}`));
    } finally {
      await context.close();
    }
  });
});
