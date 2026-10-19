import { test, expect } from '../fixtures/test';
import { AdminApi, canUseAdminApi } from '../pages/AdminApi';
import { HostEnvironmentPage } from '../pages/HostManagementPages';
import { HostNav } from '../pages/HostPages';

const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';

function writes(urlPart: string, method: string, into: string[]) {
  return (request: { method(): string; url(): string }) => {
    if (request.method() === method && request.url().includes(urlPart)) into.push(request.url());
  };
}

test.describe('Environment settings (QC-742)', () => {
  test('ENV-01 settings are grouped in panels, and every secret is an empty password box that only says whether it is set', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await expect(new HostNav(page).tab('environment')).toHaveClass(/active/);
    await expect(environment.intro).toContainText('Blank sensitive fields keep their current value');
    await expect(page.locator('.qc-kpi')).toHaveCount(0);
    expect(await environment.groups().count()).toBeGreaterThan(1);

    const secrets = environment.secretFields();
    expect(await secrets.count()).toBeGreaterThan(0);
    for (const secret of await secrets.all()) {
      await expect(secret.locator('input[type="password"]')).toHaveValue('');
      await expect(secret.locator('mat-hint')).toHaveText(/^\s*(Set|Not set)\s*$/);
    }
  });

  test('ENV-02 the first group starts open, and which panels are open is remembered across a reload', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.forgetOpenGroups();
    await environment.open(targetHost.uuid);

    const [first, second] = await environment.groupNames();
    expect(await environment.isExpanded(first)).toBe(true);
    expect(await environment.isExpanded(second)).toBe(false);
    expect(await environment.openGroupsStored()).toBeNull();

    try {
      await environment.setExpanded(second, true);
      await environment.setExpanded(first, false);
      expect(await environment.openGroupsStored()).toEqual([second]);

      await environment.open(targetHost.uuid);
      await expect(environment.groupHeader(second)).toHaveAttribute('aria-expanded', 'true');
      await expect(environment.groupHeader(first)).toHaveAttribute('aria-expanded', 'false');

      await environment.setExpanded(second, false);
      expect(await environment.openGroupsStored()).toEqual([]);
      await environment.open(targetHost.uuid);
      for (const name of await environment.groupNames()) {
        await expect(environment.groupHeader(name), `${name} stays collapsed`).toHaveAttribute('aria-expanded', 'false');
      }
    } finally {
      await environment.forgetOpenGroups();
    }
  });

  test('ENV-03 a non-whole number is caught in the browser, and the Admin API refuses one sent directly; nothing is saved', { tag: '@write' }, async ({ page, request, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const id = await environment.settingId(SAFE_SETTING);
    const puts: string[] = [];
    page.on('request', writes('/environment', 'PUT', puts));

    await environment.setValue(SAFE_SETTING, '1.5');
    await environment.save.click();
    await expect(environment.error(SAFE_SETTING)).toHaveText('Enter a whole number.');
    await shell.expectStatus('Fix the highlighted fields first.', 'error');
    expect(puts, 'nothing was sent').toEqual([]);

    if (canUseAdminApi()) {
      const refused = await AdminApi.asAdmin(request).put(`/hosts/${targetHost.uuid}/environment`, { values: { [id]: 'abc' }, secrets: {} });
      expect(refused.status).toBe(400);
      expect(refused.body.detail).toContain('The host API refused the change');
      expect(refused.body.errors[id]?.[0]).toContain('whole number');
    }

    await environment.open(targetHost.uuid);
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
  });

  test('ENV-04 saving a restart-required setting warns, offers a countdown that Not now stops, leaves the amber card, and survives a reload', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    test.setTimeout(90_000);
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const probe = original === '21' ? '22' : '21';
    const restarts: string[] = [];
    page.on('request', writes('/restart', 'POST', restarts));

    try {
      await environment.setValue(SAFE_SETTING, probe);
      await expect(environment.save).toHaveText(/Save \(1\)/);
      await environment.save.click();
      await shell.expectStatus(`Saved 1 setting. Restart the host API for these to take effect: ${SAFE_SETTING}.`, 'warning');

      await expect(environment.countdown.root).toBeVisible();
      await expect(environment.countdown.keys).toHaveText([SAFE_SETTING]);
      const first = await environment.countdown.secondsLeft();
      expect(first).toBeLessThanOrEqual(10);
      await expect.poll(() => environment.countdown.secondsLeft(), { timeout: 3_000 }).toBeLessThan(first);
      await environment.countdown.decline();

      await expect(environment.restartCard).toBeVisible();
      await expect(environment.restartCardKeys).toHaveText([SAFE_SETTING]);
      await expect(environment.cardRestart.arm).toBeVisible();

      await page.waitForTimeout(11_000);
      expect(restarts, 'Not now stopped the countdown: no restart was requested').toEqual([]);

      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);
      await expect(environment.restartCard).toHaveCount(0);
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.setValue(SAFE_SETTING, original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
        await environment.countdown.decline();
      }
    }
    expect(restarts).toEqual([]);
  });

  test('ENV-05 a confirmed restart is requested and reported', { tag: '@restart' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restart.arm.click();
    await environment.restart.confirm.click();
    await shell.expectStatus('Restart requested.');
  });

  test('ENV-06 Restart takes two clicks, and Cancel sends nothing', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const restarts: string[] = [];
    page.on('request', writes('/restart', 'POST', restarts));

    await expect(environment.restart.arm).toContainText('Restart application');
    await expect(environment.restart.confirm).toHaveCount(0);
    await environment.restart.arm.click();
    await expect(environment.restart.confirm).toHaveText(/Yes, restart now/);
    await expect(page.locator('.restart-warning')).toContainText('Every signed-in user is disconnected');
    await environment.restart.cancel.click();
    await expect(environment.restart.arm).toBeVisible();
    await expect(environment.restart.confirm).toHaveCount(0);
    expect(restarts).toEqual([]);
  });

  test('ENV-07 Save is off until something changes, counts the changes, and Reset throws them away without calling the API', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const puts: string[] = [];
    page.on('request', writes('/environment', 'PUT', puts));

    await expect(environment.save).toHaveText(/^\s*Save\s*$/);
    await expect(environment.save).toBeDisabled();

    await environment.setValue(SAFE_SETTING, String(Number(original) + 1));
    await expect(environment.save).toHaveText(/Save \(1\)/);
    await expect(environment.save).toBeEnabled();

    await environment.reset.click();
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
    await expect(environment.save).toBeDisabled();
    expect(puts).toEqual([]);
  });
});
