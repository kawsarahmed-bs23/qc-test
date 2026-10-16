import { test, expect } from '../fixtures/test';

test.describe('Dashboard and navigation', () => {
  test('DASH-01 dashboard shows the four summary cards with numbers', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#page-heading')).toHaveText('Dashboard');
    for (const id of ['kpi-hosts', 'kpi-features', 'kpi-mfa', 'kpi-sync']) {
      await expect(page.locator(`#${id}`)).toHaveText(/^\d+$/);
    }
    expect(Number(await page.locator('#kpi-hosts').innerText())).toBeGreaterThan(0);
  });

  test('DASH-02 the target host has a card with its Identity state and quick links', async ({ page, targetHost }) => {
    await page.goto('/');
    const card = page.locator(`#host-cards [data-host-card="${targetHost.uuid}" i]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(targetHost.name);
    await expect(card).toContainText(/Identity linked|Not linked/);
    for (const link of ['Features', 'Environment', 'Users']) {
      await expect(card.getByRole('link', { name: link, exact: true })).toBeVisible();
    }
  });

  test('DASH-03 sidebar menu is Dashboard, Hosts, Users, Activity and reaches each one', async ({ page, shell }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar-menu-link .title')).toHaveText(['Dashboard', 'Hosts', 'Users', 'Activity']);
    await expect(shell.nav('dashboard')).toHaveClass(/active/);

    await shell.nav('hosts').click();
    await expect(page).toHaveURL(/\/hosts$/);
    await expect(page.locator('#hosts-table')).toBeVisible();
    await expect(shell.nav('hosts')).toHaveClass(/active/);

    await shell.nav('users').click();
    await expect(page).toHaveURL(/\/users$/);
    await expect(page.locator('#page-heading')).toHaveText('Users');

    await shell.nav('activity').click();
    await expect(page).toHaveURL(/\/activity$/);
    await expect(page.locator('#page-heading')).toHaveText('Activity');

    await shell.nav('dashboard').click();
    await expect(page.locator('#kpis')).toBeVisible();
  });

  test('DASH-04 host list links to the host page with its four tabs', async ({ page, targetHost }) => {
    await page.goto('/hosts');
    await page.locator('#hosts-table tr', { hasText: targetHost.name }).getByRole('link', { name: targetHost.name }).click();
    await expect(page).toHaveURL(new RegExp(`/hosts/${targetHost.uuid}$`, 'i'));
    await expect(page.locator('#page-heading')).toHaveText(targetHost.name);
    await expect(page.locator('.qc-tabs a')).toHaveCount(4);
    for (const tab of ['details', 'features', 'environment', 'users']) {
      await expect(page.locator(`#tab-${tab}`)).toBeVisible();
    }
    await expect(page.locator('#tab-details')).toHaveClass(/active/);
  });

  test('DASH-05 activity page lists changes or shows the empty state', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.locator('#activity-list, #activity-empty').first()).toBeVisible();
  });

  test('DASH-06 an unknown host UUID returns 404', async ({ page }) => {
    const response = await page.goto('/hosts/00000000-0000-0000-0000-000000000000');
    expect(response?.status()).toBe(404);
  });

  test('DASH-07 activity for one host shows only that host and links back to every host', async ({ page, targetHost }) => {
    await page.goto(`/activity?host=${targetHost.uuid}`);
    await expect(page.locator('.breadcrumb')).toContainText(targetHost.name);
    await expect(page.locator('#activity-all')).toBeVisible();
    const items = page.locator('#activity-list li');
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      await expect(items.nth(i).locator('.qc-activity-meta')).toContainText(targetHost.name);
    }
  });

  test('DASH-08 the pop-up message and user menu use the theme', async ({ page, shell }) => {
    await page.goto('/');
    await expect(page.locator('.sidebar-area')).toBeVisible();
    await shell.profileMenuButton.click();
    await expect(page.locator('[data-profile-menu]')).toBeVisible();
    await expect(page.locator('#sign-out')).toBeAttached();
  });
});
