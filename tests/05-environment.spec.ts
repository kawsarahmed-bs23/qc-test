import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/test';
import { EnvironmentPage, HostOverviewPage } from '../pages/HostPages';

interface SettingInfo {
  key: string;
  type: string;
  restart: boolean;
  value: string;
}

async function findSetting(page: Page, predicate: (s: SettingInfo) => boolean): Promise<SettingInfo> {
  const settings = await page.locator('[data-setting-row]').evaluateAll((rows) =>
    rows
      .filter((row) => !row.querySelector('[data-sensitive]'))
      .map((row) => {
        const chips = row.querySelectorAll('.qc-setting-tags .qc-chip');
        const input = row.querySelector('input, select, textarea') as HTMLInputElement | null;
        return {
          key: chips[0]?.textContent?.trim() ?? '',
          type: chips[1]?.textContent?.trim() ?? '',
          restart: Array.from(chips).some((chip) => chip.textContent?.includes('restart')),
          value: input?.value ?? '',
          tag: input?.tagName ?? '',
        };
      }),
  );
  const candidates = settings.filter((s) => s.tag === 'INPUT' && /^\d+$/.test(s.value) && SAFE_KEYS.includes(s.key) && predicate(s));
  const match = candidates.sort((a, b) => SAFE_KEYS.indexOf(a.key) - SAFE_KEYS.indexOf(b.key))[0];
  if (!match) throw new Error(`None of the safe test keys (${SAFE_KEYS.join(', ')}) is editable on this host.`);
  return match;
}

const SAFE_KEYS = [
  'DispatchSnapshot:RateLimitPermitsPerHour',
  'DriverLocation:LowBatteryPct',
  'DriverLocation:LowBatteryIntervalSeconds',
  'DriverLocation:IdleIntervalSeconds',
];

test.describe('Environment settings', () => {
  test('ENV-01 page has no summary cards, groups the settings and locks sensitive values', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const environment = new EnvironmentPage(page);
    await environment.open(targetHost.uuid);

    await expect(page.locator('.qc-kpi')).toHaveCount(0);
    expect(await page.locator('[data-setting-group]').count()).toBeGreaterThan(0);

    const locked = page.locator('[data-sensitive]');
    for (const row of await locked.all()) {
      await expect(row).toContainText('Managed externally');
    }
    await expect(page.locator('[data-setting-row]:has([data-sensitive]) input')).toHaveCount(0);
  });

  test('ENV-02 the filter narrows the list and shows an empty state for no match', async ({ page, targetHost }) => {
    const environment = new EnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const total = await page.locator('[data-setting-row]').count();

    await environment.filter.fill('timezone');
    const visible = await page.locator('[data-setting-row]:visible').count();
    expect(visible).toBeGreaterThan(0);
    expect(visible).toBeLessThan(total);

    await environment.filter.fill('zz-no-such-setting-zz');
    await expect(page.locator('[data-setting-empty]')).toBeVisible();
  });

  test('ENV-03 a non-numeric value in a whole-number setting is rejected and nothing is saved', { tag: '@write' }, async ({ page, targetHost }) => {
    const environment = new EnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const setting = await findSetting(page, (s) => s.type === 'int');

    await environment.setValue(setting.key, 'abc');
    await environment.save.click();

    await expect(environment.errors).toContainText('Nothing was saved');
    await expect(environment.errors).toContainText(`${setting.key} must be a whole number`);

    await environment.open(targetHost.uuid);
    await environment.reveal(setting.key);
    await expect(environment.input(setting.key)).toHaveValue(setting.value);
  });

  test('ENV-04 saving a restart-required setting opens the restart countdown; Not now leaves a reminder', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const environment = new EnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const setting = await findSetting(page, (s) => s.type === 'int' && s.restart);
    const changed = String(Number(setting.value) + 1);

    async function saveAndDecline(value: string): Promise<void> {
      await environment.setValue(setting.key, value);
      await environment.save.click();
      await shell.expectStatus(/setting\(s\) saved\. Pushed to live/);

      await expect(environment.restartDialog).toBeVisible();
      await expect(environment.restartDialog.locator('[data-restart-keys]')).toContainText(setting.key);

      if ((await environment.restartDialog.getAttribute('data-can-restart')) !== 'true') {
        await expect(environment.restartDialog.locator('[data-restart-unavailable]')).toBeVisible();
        await expect(environment.restartDialog.locator('[data-restart-countdown-box]')).toBeHidden();
        await page.locator('#restart-cancel').click();
        await expect(environment.restartCard).toBeVisible();
        return;
      }

      const first = Number(await environment.restartDialog.locator('[data-restart-seconds]').innerText());
      expect(first).toBeLessThanOrEqual(10);
      await expect
        .poll(async () => Number(await environment.restartDialog.locator('[data-restart-seconds]').innerText()), { timeout: 3_000 })
        .toBeLessThan(first);

      await page.locator('#restart-cancel').click();
      await expect(environment.restartDialog).toBeHidden();
      await expect(environment.restartCard).toBeVisible();
      await expect(environment.restartCard).toContainText(setting.key);
    }

    try {
      await test.step(`change ${setting.key} to ${changed}`, () => saveAndDecline(changed));

      await test.step('the countdown really stopped: nothing restarts after 10 seconds', async () => {
        await page.waitForTimeout(11_000);
        await expect(page.locator('[data-restart-step="progress"]')).toBeHidden();
      });

      await test.step('overview reports Environment in sync with live', async () => {
        const overview = new HostOverviewPage(page);
        await overview.open(targetHost.uuid);
        expect(await overview.driftOf('Environment')).toBe('in-sync');
      });
    } finally {
      await environment.open(targetHost.uuid);
      await environment.reveal(setting.key);
      if ((await environment.input(setting.key).inputValue()) !== setting.value) {
        await saveAndDecline(setting.value);
      }
    }
  });

  test('ENV-05 Restart host API restarts it and waits until it is back', { tag: '@restart' }, async ({ page, targetHost }) => {
    test.setTimeout(120_000);
    const environment = new EnvironmentPage(page);
    await environment.open(targetHost.uuid);

    await page.locator('#restart-host-api').click();
    await expect(environment.restartDialog).toBeVisible();
    await expect(environment.restartDialog.locator('[data-restart-countdown-box]')).toBeHidden();
    await page.locator('#restart-now').click();

    await expect(page.locator('[data-restart-progress-title]')).toHaveText('Host API is back', { timeout: 90_000 });
  });
});
