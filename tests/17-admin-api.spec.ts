import { test, expect, signedOut } from '../fixtures/test';
import { AdminApi, accessTokenFromPage, adminTokenFromState, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';
import { decodeJwt } from '../pages/PasswordGrantApi';
import { adminAccount, canSeedThrowawayUsers, removeIdentityUsers, seedIdentityUser } from '../fixtures/throwawayUsers';
import { env } from '../config/environment';

const ADMIN_AUDIENCE = 'quarryconnect.admin.api';
const OTHER_ORIGIN = 'http://localhost:4401';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_KEYS = ['hostUuid', 'name', 'hostKey', 'clientId', 'databaseName', 'uiUrl', 'apiBaseUrl', 'hostOrganisationId', 'hasApiBaseUrl'];
const USER_KEYS = ['userId', 'email', 'displayName', 'isActive', 'lastLogin', 'isPlatformAdmin'];
const READ_PATHS = ['/me', '/dashboard', '/hosts', '/activity', '/users', '/users/filters'];
const ADMIN_PATHS = READ_PATHS.filter((path) => path !== '/me');
const NOT_AN_ADMIN = 'e2e.qc775.t.adminapi02@quarryconnect.test';

function keysDeep(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => keysDeep(item, found));
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      found.add(key);
      keysDeep(child, found);
    }
  }
  return found;
}

test.describe('Admin API (QC-742)', () => {
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');

  test.describe('without the Admin role', () => {
    test.use(signedOut);

    test('ADMINAPI-01 every endpoint refuses a call with no token or a token it did not issue', async ({ request }) => {
      for (const token of [null, 'not-a-token']) {
        const api = new AdminApi(request, token);
        for (const path of READ_PATHS) {
          expect((await api.get(path)).status, `${path} with ${token ?? 'no token'}`).toBe(401);
        }
        expect((await api.post('/hosts', { name: 'x' })).status).toBe(401);
      }
    });

    test('ADMINAPI-02 a signed-in account that is not a platform admin lands on Permission denied; /me answers and every other path gets 403', { tag: '@write' }, async ({ page, request }) => {
      test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database for a throwaway account with two-step verification (Admin requires it, QC-775).");
      const user = seedIdentityUser(NOT_AN_ADMIN, 'QC-775 Admin API', true);

      try {
        await page.goto(adminUrl('/hosts'));
        await new IdentityLoginPage(page).signInWithTwoStep(user, user.authenticatorKey!);

        await expect(page).toHaveURL(adminUrl('/permission-denied'));
        await expect(page.locator('#permission-denied-page')).toBeVisible();
        await expect(page.locator('#permission-denied-message')).toContainText('Only platform admins can sign in here.');
        await expect(page.locator('#permission-denied-sign-out')).toBeVisible();
        await expect(page.locator('#nav-dashboard')).toHaveCount(0);

        await page.goto(adminUrl('/users'));
        await expect(page).toHaveURL(adminUrl('/permission-denied'));

        const token = await accessTokenFromPage(page);
        expect(token, 'the account got an access token').toBeTruthy();
        expect(decodeJwt(token!).claims.aud).toContain(ADMIN_AUDIENCE);
        const api = new AdminApi(request, token);
        expect((await api.get('/me')).body).toMatchObject({ userId: user.userId, email: user.email, isAdmin: false, needsTwoFactor: false });
        for (const path of ADMIN_PATHS) {
          expect((await api.get(path)).status, path).toBe(403);
        }
      } finally {
        removeIdentityUsers(NOT_AN_ADMIN);
      }
    });
  });

  test('ADMINAPI-03 the Admin token carries the Admin API audience and mfa but no role, and reads every list', async ({ request }) => {
    const token = adminTokenFromState();
    const claims = decodeJwt(token).claims;
    expect(claims.aud).toContain(ADMIN_AUDIENCE);
    expect([claims.amr].flat()).toContain('mfa');
    expect(claims).not.toHaveProperty('role');

    const api = new AdminApi(request, token);
    for (const path of READ_PATHS) {
      const result = await api.get(path);
      expect(result.status, path).toBe(200);
      expect(result.headers['content-type'], path).toContain('application/json');
    }
    expect((await api.get('/me')).body).toMatchObject({ email: adminAccount()!.email, userId: claims.sub, isAdmin: true, needsTwoFactor: false });
  });

  test('ADMINAPI-04 CORS lets the Admin app origin call the API and nobody else', async ({ request }) => {
    const api = new AdminApi(request, null);

    const allowed = await api.preflight('/hosts', env.adminUrl, 'PUT');
    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(env.adminUrl);
    expect(allowed.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
    expect(allowed.headers['access-control-allow-methods']).toContain('PUT');

    const refused = await api.preflight('/hosts', OTHER_ORIGIN, 'PUT');
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();

    const admin = AdminApi.asAdmin(request);
    expect((await admin.get('/hosts', { Origin: env.adminUrl })).headers['access-control-allow-origin']).toBe(env.adminUrl);
    expect((await admin.get('/hosts', { Origin: OTHER_ORIGIN })).headers['access-control-allow-origin']).toBeUndefined();
  });

  test('ADMINAPI-05 hosts and users are identified by UUIDs and GUIDs; no HOST_MASTER key is ever sent', async ({ request, targetHost }) => {
    const api = AdminApi.asAdmin(request);

    const hosts = await api.get('/hosts');
    expect(hosts.status).toBe(200);
    for (const host of hosts.body) {
      expect(Object.keys(host).sort()).toEqual([...HOST_KEYS].sort());
      expect(host.hostUuid).toMatch(GUID);
    }
    const one = await api.get(`/hosts/${targetHost.uuid}`);
    expect(Object.keys(one.body).sort()).toEqual([...HOST_KEYS].sort());

    for (const path of ['/hosts', `/hosts/${targetHost.uuid}`, '/dashboard', '/activity', '/users', '/users/filters', `/hosts/${targetHost.uuid}/branding`, `/hosts/${targetHost.uuid}/urls`]) {
      const keys = keysDeep((await api.get(path)).body);
      for (const key of ['id', 'hostId', 'changeLogId']) {
        expect(keys.has(key), `${path} has no ${key}`).toBe(false);
      }
    }

    const users = await api.get('/users?pageSize=100');
    for (const user of users.body.items) {
      expect(user.userId).toMatch(GUID);
      expect(Object.keys(user).sort()).toEqual([...USER_KEYS].sort());
    }
    expect((await api.get(`/hosts/${targetHost.uuid}/users`)).status, 'the host users endpoint is gone (QC-775)').toBe(404);

  });

  test('ADMINAPI-06 failures come back as problem details: camelCase field errors on 400, and 404 for an unknown host', async ({ request }) => {
    const api = AdminApi.asAdmin(request);

    const invalid = await api.post('/hosts', {});
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ status: 400, title: 'The request could not be completed.', detail: 'Check the highlighted fields.' });
    expect(Object.keys(invalid.body.errors)).toEqual(expect.arrayContaining(['name', 'hostKey', 'clientId', 'databaseName', 'uiUrl', 'hostOrganisationId']));
    for (const key of Object.keys(invalid.body.errors)) {
      expect(key, 'field keys are camelCase').toMatch(/^[a-z][A-Za-z0-9]*$/);
    }

    const unknown = '00000000-0000-0000-0000-000000000000';
    for (const path of [`/hosts/${unknown}`, `/hosts/${unknown}/features`, `/hosts/${unknown}/environment`, `/hosts/${unknown}/branding`, `/hosts/${unknown}/urls`, `/activity?host=${unknown}`]) {
      expect((await api.get(path)).status, path).toBe(404);
    }
    expect((await api.get('/users/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await api.get('/hosts/42')).status, 'a numeric host id is not a route').toBe(404);
  });
});
