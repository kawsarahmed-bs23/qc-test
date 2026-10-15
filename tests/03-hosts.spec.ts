import { test, expect } from '../fixtures/test';
import { AREAS, HostOverviewPage } from '../pages/HostPages';

test.describe('Host registry and sync overview', () => {
  test('HOST-01 overview compares every area with live and none is unreachable', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const overview = new HostOverviewPage(page);
    await overview.open(targetHost.uuid);
    for (const area of AREAS) {
      await expect(overview.areaRow(area)).toBeVisible();
      expect(await overview.driftOf(area), `${area} must be reachable`).not.toBe('error');
    }
  });

  test('HOST-02 the registry card shows the host UUID, never a numeric id', async ({ page, targetHost }) => {
    await new HostOverviewPage(page).open(targetHost.uuid);
    await expect(page.locator('.qc-dl')).toContainText(targetHost.uuid);
    expect(page.url()).not.toMatch(/\/hosts\/\d+(\/|$)/);
  });

  test('HOST-03 Add host rejects an existing name and client id without saving', { tag: '@write' }, async ({ page, targetHost }) => {
    await page.goto(`/hosts/${targetHost.uuid}`);
    const clientId = await page.locator('#Form_ClientId').inputValue();
    const database = await page.locator('#Form_DatabaseName').inputValue();
    const organisation = await page.locator('#Form_HostOrganisationId').inputValue();

    await page.goto('/hosts/new');
    await page.locator('#Form_Name').fill(targetHost.name);
    await page.locator('#Form_ClientId').fill(clientId);
    await page.locator('#Form_DatabaseName').fill(database);
    await page.locator('#Form_HostOrganisationId').fill(organisation);
    await page.locator('#host-create').click();

    await expect(page).toHaveURL(/\/hosts\/new$/);
    await expect(page.locator('[data-field-error="Name"]')).toHaveText('Another host already uses this name.');
    await expect(page.locator('[data-field-error="ClientId"]')).toHaveText('Another host already uses this client id.');
  });

  test('HOST-04 Add host validates required fields and the database name format', { tag: '@write' }, async ({ page }) => {
    await page.goto('/hosts/new');
    await page.locator('#Form_Name').fill('E2E validation probe');
    await page.locator('#Form_ClientId').fill('host.e2e-validation');
    await page.locator('#Form_DatabaseName').fill('bad name; drop table');
    await page.locator('#Form_HostOrganisationId').fill('0');
    await page.locator('#host-create').click();

    await expect(page.locator('[data-field-error="DatabaseName"]')).toContainText('letters, digits and underscores');
    await expect(page.locator('[data-field-error="HostOrganisationId"]')).toContainText('positive number');
  });

  test('HOST-05 a host whose database is missing is saved and shows Failed with Retry', { tag: '@create' }, async ({ page }) => {
    const stamp = Date.now();
    await page.goto('/hosts/new');
    await page.locator('#Form_Name').fill(`E2E unreachable ${stamp}`);
    await page.locator('#Form_ClientId').fill(`host.e2e${stamp}`);
    await page.locator('#Form_DatabaseName').fill(`QuarryConnect_E2E_Missing_${stamp}`);
    await page.locator('#Form_HostOrganisationId').fill('999');
    await page.locator('#host-create').click();

    await expect(page).toHaveURL(/\/hosts\/[0-9a-f-]{36}$/);
    await expect(page.locator('#status-message')).toContainText('failed');
    const overview = new HostOverviewPage(page);
    for (const area of ['Features', 'Environment', 'HostSettings'] as const) {
      expect(await overview.driftOf(area)).toBe('error');
      await expect(overview.areaRow(area).locator('[data-sync-area]')).toContainText('Retry');
    }
  });
});
