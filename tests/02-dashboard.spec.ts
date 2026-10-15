import { test, expect } from '../fixtures/test';

test.describe('Dashboard and navigation', () => {
  test('DASH-01 dashboard shows the four KPI cards with numbers', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/');
    for (const id of ['kpi-hosts', 'kpi-features', 'kpi-branding', 'kpi-sync']) {
      await expect(page.locator(`#${id}`)).toHaveText(/^\d+$/);
    }
    expect(Number(await page.locator('#kpi-hosts').innerText())).toBeGreaterThan(0);
  });

  test('DASH-02 the target host has a card with features meter, chips and quick links', async ({ page, targetHost }) => {
    await page.goto('/');
    const card = page.locator('.qc-host-card', { hasText: targetHost.name });
    await expect(card).toBeVisible();
    await expect(card.locator('.qc-meter-label')).toContainText(/\d+ of \d+ on/);
    for (const link of ['Features', 'Environment', 'Settings', 'Branding']) {
      await expect(card.getByRole('link', { name: link })).toBeVisible();
    }
  });

  test('DASH-03 sidebar menu is Dashboard, All Hosts, Activity and reaches each one', async ({ page, shell }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar-menu-link .title')).toHaveText(['Dashboard', 'All Hosts', 'Activity']);
    await expect(page.locator('#nav-host-new')).toHaveCount(0);

    await shell.nav('hosts').click();
    await expect(page).toHaveURL(/\/hosts$/);
    await expect(page.locator('#hosts-table')).toBeVisible();

    await shell.nav('activity').click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible();

    await shell.nav('dashboard').click();
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  });

  test('DASH-04 host list links to the host overview with its four tabs', async ({ page, targetHost }) => {
    await page.goto('/hosts');
    await page.locator('#hosts-table tr', { hasText: targetHost.name }).getByRole('link', { name: 'Manage' }).click();
    await expect(page).toHaveURL(new RegExp(`/hosts/${targetHost.uuid}$`));
    await expect(page.locator('#page-heading')).toHaveText(targetHost.name);
    await expect(page.locator('.qc-tabs a')).toHaveCount(4);
    for (const tab of ['overview', 'features', 'environment', 'settings']) {
      await expect(page.locator(`#tab-${tab}`)).toBeVisible();
    }
    await expect(page.locator('#tab-branding')).toHaveCount(0);
  });

  test('DASH-07 the old branding URL redirects to the branding section of Host settings', async ({ page, targetHost }) => {
    await page.goto(`/hosts/${targetHost.uuid}/branding`);
    await expect(page).toHaveURL(new RegExp(`/hosts/${targetHost.uuid}/settings#sign-in-branding$`));
    await expect(page.locator('#sign-in-branding')).toBeVisible();
  });

  test('DASH-05 activity page lists changes or shows the empty state', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.locator('#activity-list, .qc-empty-state').first()).toBeVisible();
  });

  test('DASH-06 an unknown host UUID returns 404', async ({ page }) => {
    const response = await page.goto('/hosts/00000000-0000-0000-0000-000000000000');
    expect(response?.status()).toBe(404);
  });
});
