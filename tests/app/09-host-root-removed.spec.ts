import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import {
  HostNotFoundPage,
  HostRootApi,
  HostSidebar,
  QC801_ADMIN_EMAIL,
  QC801_ADMIN_STATE,
  QC801_SUPERADMIN_EMAIL,
  Qc801HostUsers,
  ROOT_ENDPOINTS,
  removeSuperAdminRole,
  seedSuperAdminRole,
  superAdminRowCounts,
} from '@pages/host-root-removed.page';

const REMOVED_ROUTES = ['/environment-settings', '/feature-toggles'];
const REMOVED_LABELS = ['Environment Settings', 'Feature Settings'];
const NO_SUPERADMIN = { roles: 0, userToRoles: 0, rolesToPermissions: 0, roleClaims: 0 };

test.describe('The host app has no root super admin: settings and features belong to Admin (QC-801)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), 'Needs the host and Identity local databases for the throwaway host users.');
  test.skip(
    !env.appUrl || !env.appApiUrl || !env.admin,
    'Needs APP_URL, APP_API_URL and ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway users copy that password).',
  );
  test.use({ storageState: QC801_ADMIN_STATE });

  let admin: ThrowawayUser;
  let adminToken: string;

  test.beforeAll(async ({ browser }) => {
    Qc801HostUsers.remove();
    admin = Qc801HostUsers.seed(QC801_ADMIN_EMAIL, 'Admin');
    adminToken = await Qc801HostUsers.signIn(browser, admin, QC801_ADMIN_STATE);
  });

  test.afterAll(() => {
    try {
      Qc801HostUsers.remove();
    } finally {
      removeSuperAdminRole();
    }
  });

  test('ROOT-01 the admin panel in the host app sidebar has no Environment Settings or Feature Settings item', async ({ page }) => {
    await page.goto('/#/admin/settings');
    const sidebar = new HostSidebar(page);
    await sidebar.openSetup();

    const items = (await sidebar.setupItems().allInnerTexts()).map((text) => text.trim());
    expect(items).toContain('Company Settings');
    for (const label of REMOVED_LABELS) {
      expect(items, `the Setup panel lists no ${label}`).not.toContain(label);
      await expect(sidebar.root.getByText(label, { exact: true })).toHaveCount(0);
    }
    for (const route of REMOVED_ROUTES) {
      await expect(sidebar.link(route), `no sidebar link to ${route}`).toHaveCount(0);
    }
  });

  for (const route of REMOVED_ROUTES) {
    test(`ROOT-02 ${route} shows the Not Found page, not the old page`, async ({ page }) => {
      const notFound = new HostNotFoundPage(page);
      await notFound.open(route);
      await expect(notFound.heading).toHaveText(/404 Page Not Found/);
      await expect(page.locator('app-environment-settings, app-feature-toggles')).toHaveCount(0);
      expect(new URL(page.url()).hash).toBe(`#${route}`);
    });
  }

  test('ROOT-03 a host Admin token is refused by environment-setting, host-feature, host-branding and messaging probes', async ({ request }) => {
    const api = new HostRootApi(request);
    for (const endpoint of ROOT_ENDPOINTS) {
      const answer = await api.call(endpoint, adminToken);
      expect([401, 403], `${endpoint.method} ${endpoint.path} as a host Admin: ${answer.status}`).toContain(answer.status);
    }
  });

  test('ROOT-04 a host user who still holds a SuperAdmin role row is refused as well', async ({ browser, request }) => {
    seedSuperAdminRole();
    try {
      const superAdmin = Qc801HostUsers.seed(QC801_SUPERADMIN_EMAIL, 'SuperAdmin');
      const token = await Qc801HostUsers.signIn(browser, superAdmin);
      const api = new HostRootApi(request);
      for (const endpoint of ROOT_ENDPOINTS) {
        const answer = await api.call(endpoint, token);
        expect([401, 403], `${endpoint.method} ${endpoint.path} as a SuperAdmin row holder: ${answer.status}`).toContain(answer.status);
      }
    } finally {
      removeSuperAdminRole();
    }
    expect(superAdminRowCounts()).toEqual(NO_SUPERADMIN);
  });

  test("ROOT-05 Admin's service token still reads the host's environment settings, features and branding", async ({ request }) => {
    test.skip(!env.adminApiClient, 'Needs ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET (the Admin service client).');
    const api = new HostRootApi(request);
    const token = await HostRootApi.adminServiceToken(request);

    const environment = await api.call(ROOT_ENDPOINTS[0], token);
    expect(environment.status, environment.text.slice(0, 300)).toBe(200);
    const body = JSON.parse(environment.text);
    const groups = Array.isArray(body) ? body : (body.groups ?? body.data ?? []);
    expect(groups.flatMap((group: { settings?: unknown[] }) => group.settings ?? []).length).toBeGreaterThan(0);

    for (const endpoint of ROOT_ENDPOINTS.slice(1, 3)) {
      const answer = await api.call(endpoint, token);
      expect(answer.status, `${endpoint.method} ${endpoint.path} with the Admin service token`).toBe(200);
    }
  });

  test('ROOT-06 the host database has no SuperAdmin row in auth.Roles, UserToRoles, RolesToPermissions or RoleClaims', () => {
    expect(superAdminRowCounts()).toEqual(NO_SUPERADMIN);
  });
});
