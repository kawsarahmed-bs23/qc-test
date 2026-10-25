import { test, expect } from '../fixtures/test';
import { canUseMasterDb, queryMasterDb } from '../fixtures/localDb';
import { adminUrl, openAdmin } from '../pages/AdminShell';
import { HostListPage } from '../pages/HostManagementPages';
import { ActivityPage, DashboardPage, HOST_TABS, HostNav, KPIS } from '../pages/HostPages';
import { adminAccount } from '../fixtures/throwawayUsers';

test.describe('Dashboard and navigation (QC-742)', () => {
  test('DASH-01 dashboard shows the four summary cards with numbers', { tag: '@smoke' }, async ({ page, shell }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.open();
    await expect(shell.heading).toHaveText('Dashboard');
    for (const id of KPIS) {
      await expect(dashboard.kpi(id)).toHaveText(/^\d+$/);
    }
    expect(Number(await dashboard.kpi('kpi-hosts').innerText())).toBeGreaterThan(0);
  });

  test('DASH-02 the target host has a card with its sign-in state and quick links (QC-775)', async ({ page, targetHost }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.open();
    const card = dashboard.hostCard(targetHost.uuid);
    await expect(card).toBeVisible();
    await expect(card.locator('[data-testid="host-card-link"]')).toHaveText(targetHost.name);
    await expect(dashboard.signInState(targetHost.uuid)).toHaveText(/^(Sign-in ready|No return address)$/);
    await expect(card).not.toContainText('Identity linked');
    await expect(card.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    for (const [link, path] of [['Features', 'features'], ['Environment', 'environment'], ['Sign-in', 'sign-in']]) {
      await expect(card.getByRole('link', { name: link, exact: true })).toHaveAttribute('href', `#/hosts/${targetHost.uuid}/${path}`);
    }
  });

  test('DASH-03 sidebar menu is Dashboard, Hosts, Users, Activity and reaches each one', async ({ page, shell }) => {
    await new DashboardPage(page).open();
    await expect(page.locator('#sidebar .sidebar-menu-link .title')).toHaveText(['Dashboard', 'Hosts', 'Users', 'Activity']);
    await expect(shell.nav('dashboard')).toHaveClass(/active/);

    await shell.nav('hosts').click();
    await expect(page).toHaveURL(adminUrl('/hosts'));
    await expect(page.locator('#hosts-table')).toBeVisible();
    await expect(shell.nav('hosts')).toHaveClass(/active/);
    await expect(shell.nav('dashboard')).not.toHaveClass(/active/);

    await shell.nav('users').click();
    await expect(page).toHaveURL(adminUrl('/users'));
    await expect(shell.heading).toHaveText('Users');

    await shell.nav('activity').click();
    await expect(page).toHaveURL(adminUrl('/activity'));
    await expect(shell.heading).toHaveText('Activity');

    await shell.nav('dashboard').click();
    await expect(page.locator('#kpis')).toBeVisible();
  });

  test('DASH-04 host list links to the host page with its five tabs: Details, Sign-in, Environment, Features, Activity (QC-775)', async ({ page, shell, targetHost }) => {
    const list = new HostListPage(page);
    await list.open();
    await list.link(targetHost.uuid).click();
    await expect(page).toHaveURL(adminUrl(`/hosts/${targetHost.uuid}`));
    await expect(shell.heading).toHaveText(targetHost.name);
    await expect(shell.breadcrumb).toContainText(targetHost.name);

    const nav = new HostNav(page);
    await expect(nav.all()).toHaveCount(HOST_TABS.length);
    await expect(nav.all()).toHaveText(['Details', 'Sign-in', 'Environment', 'Features', 'Activity'].map((label) => new RegExp(`${label}\\s*$`)));
    for (const tab of HOST_TABS) {
      await expect(nav.tab(tab)).toBeVisible();
    }
    await expect(nav.tab('details')).toHaveClass(/active/);
    await expect(nav.tab('activity')).toHaveAttribute('href', `#/activity?host=${targetHost.uuid}`);
  });

  test('DASH-05 activity page lists changes or shows the empty state', async ({ page, shell }) => {
    const activity = new ActivityPage(page);
    await activity.open();
    await expect(shell.heading).toHaveText('Activity');
    await expect(activity.list.list.or(activity.list.empty)).toBeVisible();
    await expect(activity.showAll).toHaveCount(0);
  });

  test('DASH-06 an unknown host UUID shows the not-found page, which leads back to the dashboard', async ({ page, shell }) => {
    await openAdmin(page, '/hosts/00000000-0000-0000-0000-000000000000');
    await shell.expectNotFound();
    await page.locator('#not-found-home').click();
    await expect(page.locator('#kpis')).toBeVisible();
  });

  test('DASH-07 activity for one host shows only that host and links back to every host', async ({ page, shell, targetHost }) => {
    const activity = new ActivityPage(page);
    await activity.open(targetHost.uuid);
    await expect(shell.breadcrumb).toContainText(targetHost.name);
    await expect(activity.subtitle).toContainText(targetHost.name);
    await expect(new HostNav(page).tab('activity')).toHaveClass(/active/);
    await expect(activity.showAll).toBeVisible();
    for (const entry of await activity.list.entries.all()) {
      await expect(entry.locator('[data-testid="activity-host-link"]')).toHaveText(targetHost.name);
    }

    await activity.showAll.click();
    await expect(page).toHaveURL(adminUrl('/activity'));
    await expect(activity.showAll).toHaveCount(0);
  });

  test('DASH-08 the user menu shows the signed-in admin and a sign-out item', async ({ page, shell }) => {
    const admin = adminAccount();
    test.skip(!admin, 'No admin credentials');
    await new DashboardPage(page).open();
    await expect(page.locator('#sidebar')).toBeVisible();
    await shell.profileMenuButton.click();
    await expect(shell.userEmail).toHaveText(admin!.email);
    await expect(shell.userName).not.toBeEmpty();
    await expect(page.locator('#sign-out')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#sign-out')).toBeHidden();
  });

  test('DASH-09 an unknown address inside the app shows the not-found page', async ({ page, shell }) => {
    await openAdmin(page, '/no-such-page');
    await shell.expectNotFound();
    await expect(shell.nav('dashboard')).toBeVisible();
  });

  test('DASH-10 the host count and host cards match the active hosts in HOST_MASTER', async ({ page }) => {
    test.skip(!canUseMasterDb(), 'Needs MASTER_SQL_DATABASE (local only).');
    const dashboard = new DashboardPage(page);
    await dashboard.open();
    const active = Number(queryMasterDb('SELECT COUNT(*) FROM app.Hosts WHERE Active = 1'));
    await expect(dashboard.kpi('kpi-hosts')).toHaveText(String(active));
    await expect(dashboard.hostCards).toHaveCount(active);
  });

  test('DASH-11 the dashboard buttons reach Add host, the hosts list and the activity log', async ({ page, shell }) => {
    const dashboard = new DashboardPage(page);
    await dashboard.open();
    await dashboard.addHost.click();
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    await expect(shell.heading).toHaveText('Add host');

    await dashboard.open();
    await dashboard.viewHosts.click();
    await expect(page).toHaveURL(adminUrl('/hosts'));

    await dashboard.open();
    await dashboard.viewActivity.click();
    await expect(page).toHaveURL(adminUrl('/activity'));
  });
});
