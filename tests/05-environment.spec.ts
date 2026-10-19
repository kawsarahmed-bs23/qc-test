import { test, expect } from '../fixtures/test';
import { HostEnvironmentPage } from '../pages/HostManagementPages';
import { HostNav } from '../pages/HostPages';

const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';

test.describe('Environment settings (QC-742)', () => {
  test('ENV-01 settings are grouped, and every secret is an empty masked box that only says whether it is set', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await expect(new HostNav(page).tab('environment')).toHaveClass(/active/);
    await expect(page.locator('.qc-kpi')).toHaveCount(0);
    expect(await environment.groups().count()).toBeGreaterThan(0);

    const secrets = environment.secretInputs();
    expect(await secrets.count()).toBeGreaterThan(0);
    await expect(environment.secretStates()).toHaveCount(await secrets.count());
    for (const secret of await secrets.all()) {
      await expect(secret).toHaveValue('');
      await expect(secret).toHaveAttribute('placeholder', /^(Set|Not set) \(type to (replace|set)\)$/);
    }
    for (const state of await environment.secretStates().all()) {
      await expect(state).toHaveText(/^\s*(Set|Not set)\s*$/);
    }
  });

  test('ENV-02 the filter narrows the list, and no match hides every group', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const total = await environment.rows().count();

    await environment.filter.fill('timezone');
    await expect.poll(() => environment.visibleRows().count()).toBeGreaterThan(0);
    expect(await environment.visibleRows().count()).toBeLessThan(total);
    await expect(environment.row('TimeZoneSettings:TimeZoneId')).toBeVisible();

    await environment.filter.fill('zz-no-such-setting-zz');
    await expect(environment.groups()).toHaveCount(0);
    await expect(environment.visibleRows()).toHaveCount(0);

    await environment.filter.fill('');
    await expect(environment.visibleRows()).toHaveCount(total);
  });

  test('ENV-03 a non-numeric value in a whole-number setting is refused on its row and nothing is saved', { tag: '@write' }, async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();

    await environment.input(SAFE_SETTING).fill('abc');
    await expect(environment.save).toHaveText(/Save changes \(1\)/);
    await environment.save.click();

    await expect(environment.errors).toContainText('The host API refused the change');
    await expect(environment.error(SAFE_SETTING)).toContainText('whole number');
    await expect(environment.row(SAFE_SETTING)).toHaveClass(/invalid/);

    await environment.open(targetHost.uuid);
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
  });

  test('ENV-04 saving a restart-required setting saves it alone, names the key in a warning, and survives a reload', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const probe = original === '21' ? '22' : '21';

    try {
      await environment.input(SAFE_SETTING).fill(probe);
      await environment.save.click();
      await shell.expectStatus(`Saved 1 setting. Restart the host API for these to take effect: ${SAFE_SETTING}.`, 'warning');

      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);
      await expect(environment.restartCard).toBeVisible();
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.input(SAFE_SETTING).fill(original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
      }
    }
  });

  test('ENV-05 a confirmed restart is requested and reported', { tag: '@restart' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restart.click();
    await environment.confirmDialog.accept();
    await shell.expectStatus('Restart requested.');
  });

  test('ENV-06 Restart asks first, and Cancel sends nothing', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/restart')) posts.push(request.url());
    });

    await environment.restart.click();
    await expect(environment.confirmDialog.title).toHaveText('Restart the host API?');
    await expect(environment.confirmDialog.message).toContainText(targetHost.name);
    await environment.confirmDialog.dismiss();
    await expect(environment.restart).toBeEnabled();
    expect(posts).toEqual([]);
  });

  test('ENV-07 Save with nothing changed says so without calling the API', async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') puts.push(request.url());
    });

    await expect(environment.save).toHaveText(/^\s*Save changes\s*$/);
    await environment.saveBottom.click();
    await shell.expectStatus('Nothing has changed.', 'info');
    expect(puts).toEqual([]);
  });
});
