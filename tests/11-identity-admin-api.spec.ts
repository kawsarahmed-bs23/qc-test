import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { canReadIdentityLog, identityLogSince, markIdentityLog } from '../fixtures/identityLog';
import { HostSignInFlow } from '../pages/HostSignInFlow';
import { ADMIN_API_SCOPE, authorizeRedirect, IdentityAdminApi, serviceToken } from '../pages/IdentityAdminApi';
import { PasswordGrantApi } from '../pages/PasswordGrantApi';
import { env } from '../config/environment';

const DEACTIVATION_USER = 'e2e.qc738.deactivate@quarryconnect.test';
const QC739_MEMBER = 'e2e.qc739.member@quarryconnect.test';
const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };
const SECRET_FIELDS = /passwordHash|securityStamp|clientSecret|"secret"/i;

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function storedGrants(email: string): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.Email = ${sqlText(email)}`));
}

test.describe('Identity administration API (QC-738)', () => {
  test.use(signedOut);
  test.skip(!env.adminApiClient, "Needs Identity's administration service client (ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET).");

  test('IDADMIN-01 the administration API refuses a call with no token or a token it did not issue', async ({ request }) => {
    expect((await new IdentityAdminApi(request, null).get('/users')).status).toBe(401);
    expect((await new IdentityAdminApi(request, 'not-a-token').get('/users')).status).toBe(401);
  });

  test('IDADMIN-02 a signed-in person cannot use their token on the administration API', async ({ page, request }) => {
    test.skip(!env.hostClient || !env.driver, 'Needs a host client (HOST_CLIENT_ID) and the seeded test driver to get a user token.');
    const flow = new HostSignInFlow(page, env.hostClient!);
    await flow.signIn(env.driver!);
    const token = await flow.exchange(request, await flow.expectCallback());
    expect(token.status, JSON.stringify(token.body)).toBe(200);

    const result = await new IdentityAdminApi(request, token.body.access_token!).get('/users');
    expect([401, 403]).toContain(result.status);
  });

  test('IDADMIN-03 the service client cannot sign a person in and a host client cannot ask for the administration scope', async ({ request }) => {
    const service = await authorizeRedirect(request, {
      client_id: env.adminApiClient!.clientId,
      response_type: 'code',
      scope: `openid ${ADMIN_API_SCOPE}`,
      redirect_uri: `${env.adminUrl}/signin-oidc`,
      ...PKCE,
    });
    expect(service).toMatch(/\/Error\?errorId=/);

    if (!env.hostClient) return;
    const user = await authorizeRedirect(request, {
      client_id: env.hostClient!.clientId,
      response_type: 'code',
      scope: `openid ${ADMIN_API_SCOPE}`,
      redirect_uri: env.hostClient!.redirectUri,
      ...PKCE,
    });
    expect(user).toMatch(/\/Error\?errorId=/);
  });

  test('IDADMIN-04 the service token reaches only the user endpoints: host, client, branding and feature endpoints are gone (QC-775)', async ({ request }) => {
    const api = await IdentityAdminApi.signIn(request);

    const users = await api.get('/users?search=e2e');
    expect(users.status).toBe(200);
    expect(Array.isArray(users.body)).toBe(true);

    for (const path of ['/hosts', '/hosts/1', '/hosts/1/clients', '/hosts/1/users', '/hosts/1/branding', '/hosts/1/features', `/clients/${env.adminApiClient!.clientId}`]) {
      expect((await api.get(path)).status, path).toBe(404);
    }
    expect([404, 405]).toContain((await api.post('/hosts', { hostKey: 'e2e-qc775-refused' })).status);
  });

  test.describe('users', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to seed the throwaway driver.");
    test.skip(!env.driver || !env.mobileClientId, 'Needs the seeded test driver and the mobile client (MOBILE_CLIENT_ID): the throwaway driver copies the driver password and signs in on the mobile client.');

    test.beforeAll(() => {
      runIdentitySeedScript('identity-deactivation-user.apply.sql', { SourceEmail: env.driver!.email });
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-deactivation-user.remove.sql');
    });

    test("IDADMIN-13 a user's details show the account and no password, host or role data (QC-775)", async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const users = await api.get(`/users?search=${encodeURIComponent(DEACTIVATION_USER)}`);
      expect(users.status).toBe(200);
      const listed = users.body.find((u: { email: string }) => u.email === DEACTIVATION_USER);
      expect(listed).toMatchObject({ isActive: true });

      const details = await api.get(`/users/${listed.userId}`);
      expect(details.status).toBe(200);
      expect(details.body).toMatchObject({ userId: listed.userId, email: DEACTIVATION_USER, isActive: true, twoFactorEnabled: false });
      for (const key of ['hosts', 'platformRoles', 'roles', 'organisationId']) {
        expect(details.body, `no ${key}`).not.toHaveProperty(key);
      }
      expect(users.text).not.toMatch(SECRET_FIELDS);
      expect(details.text).not.toMatch(SECRET_FIELDS);

      expect((await api.get('/users/no-such-user')).status).toBe(404);
    });

    test('IDADMIN-14 deactivating a user ends their refresh token and stored grants and refuses the password grant', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);
      const mobile = new PasswordGrantApi(request);
      const issued = await mobile.passwordGrant(DEACTIVATION_USER, env.driver!.password);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      expect(storedGrants(DEACTIVATION_USER)).toBeGreaterThan(0);
      const userId = queryIdentityDb(`SELECT Id FROM Users WHERE Email = ${sqlText(DEACTIVATION_USER)}`);

      const deactivated = await api.post(`/users/${userId}/deactivate`);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.isActive).toBe(false);
      expect(storedGrants(DEACTIVATION_USER)).toBe(0);

      const refreshed = await mobile.refresh(issued.body.refresh_token!);
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe('invalid_grant');

      const again = await mobile.passwordGrant(DEACTIVATION_USER, env.driver!.password);
      expect(again.status).toBe(400);
    });
  });

  test.describe('user search and account switch (QC-739)', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseIdentityDb(), "Needs Identity's local database to seed the throwaway member.");

    let userId = '';

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc739.remove.sql');
      runIdentitySeedScript('identity-qc739-member.apply.sql');
      userId = queryIdentityDb(`SELECT Id FROM Users WHERE Email = ${sqlText(QC739_MEMBER)}`)!;
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc739.remove.sql');
    });

    test('IDADMIN-16 users are found by part of their email, the page size is capped and no password data comes back', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const found = await api.get('/users?search=e2e.qc739.member');
      expect(found.status).toBe(200);
      expect(found.body).toEqual([{ userId, email: QC739_MEMBER, firstName: 'E2E', lastName: 'QC-739 Member', isActive: true }]);
      expect(found.text).not.toMatch(SECRET_FIELDS);

      expect((await api.get('/users?take=500')).body.length).toBeLessThanOrEqual(50);
      expect((await api.get(`/users?search=${'x'.repeat(300)}`)).status).toBe(400);
    });

    test('IDADMIN-19 deactivating and reactivating the account switches it off and on', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const off = await api.post(`/users/${userId}/deactivate`);
      expect(off.status).toBe(200);
      expect(off.body).toMatchObject({ userId, isActive: false });
      expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Id = ${sqlText(userId)}`)).toBe('0');

      const on = await api.post(`/users/${userId}/reactivate`);
      expect(on.status).toBe(200);
      expect(on.body).toMatchObject({ userId, isActive: true });
      expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Id = ${sqlText(userId)}`)).toBe('1');
      expect((await api.post('/users/no-such-user/reactivate')).status).toBe(404);
    });
  });

  test.describe('user list (QC-742)', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseIdentityDb(), "Needs Identity's local database to seed the e2e.qc742 users and to count users.");

    const LIST = '/users/list';
    const SEARCH = 'e2e.qc742';
    const SEEDED = `u.Email LIKE N'e2e.qc742.%'`;
    const ORDER: Record<string, string> = {
      'email asc': 'u.Email, u.Id',
      'email desc': 'u.Email DESC, u.Id',
      'name asc': 'u.LastName, u.FirstName, u.Email, u.Id',
      'name desc': 'u.LastName DESC, u.FirstName DESC, u.Email DESC, u.Id',
      'lastLogin asc': 'u.LastLoginDate, u.Email, u.Id',
      'lastLogin desc': 'u.LastLoginDate DESC, u.Email, u.Id',
    };

    const seeded = (n: number) => `e2e.qc742.u${String(n).padStart(2, '0')}@quarryconnect.test`;
    const countWhere = (where: string) => Number(queryIdentityDb(`SELECT COUNT(*) FROM Users u WHERE ${where}`));
    const emailsWhere = (where: string, orderBy = 'u.Email, u.Id') =>
      (queryIdentityDb(`SELECT u.Email FROM Users u WHERE ${where} ORDER BY ${orderBy}`) ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const list = (api: IdentityAdminApi, query: Record<string, string | number>) =>
      api.get(`${LIST}?${new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]))}`);
    const emailsOf = (body: { items: { email: string }[] }) => body.items.map((item) => item.email);
    const keysOf = (item: object) => Object.keys(item).sort();

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc742-users.apply.sql');
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc742.remove.sql');
    });

    test('IDADMIN-21 the user list refuses an unknown status, sort or direction and an overlong search, naming each field', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      for (const [query, key] of [
        [{ status: 'bogus' }, 'status'],
        [{ sort: 'createdDate' }, 'sort'],
        [{ dir: 'sideways' }, 'dir'],
        [{ search: 'x'.repeat(300) }, 'search'],
      ] as const) {
        const refused = await list(api, query);
        expect(refused.status, JSON.stringify(query)).toBe(400);
        expect(Object.keys(refused.body.errors)).toEqual([key]);
      }

      const all = await list(api, { status: 'bogus', sort: 'bogus', dir: 'bogus', search: 'x'.repeat(300) });
      expect(all.status).toBe(400);
      expect(Object.keys(all.body.errors).sort()).toEqual(['dir', 'search', 'sort', 'status']);

      const caseInsensitive = await list(api, { status: 'ACTIVE', sort: 'LASTLOGIN', dir: 'DESC', search: SEARCH });
      expect(caseInsensitive.status, caseInsensitive.text).toBe(200);
    });

    test('IDADMIN-22 the page size defaults to 25 and is clamped to 1..100, and a page past the end returns the last page', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const plain = await list(api, {});
      expect(plain.status).toBe(200);
      expect(plain.body).toMatchObject({ page: 1, pageSize: 25 });
      expect(plain.body.items).toHaveLength(Math.min(25, plain.body.totalCount));

      expect((await list(api, { search: SEARCH, pageSize: 0 })).body).toMatchObject({ pageSize: 1, totalCount: 40 });
      expect((await list(api, { search: SEARCH, pageSize: 0 })).body.items).toHaveLength(1);
      const capped = await list(api, { pageSize: 500 });
      expect(capped.body.pageSize).toBe(100);
      expect(capped.body.items).toHaveLength(Math.min(100, capped.body.totalCount));

      const past = await list(api, { search: SEARCH, pageSize: 15, page: 9999 });
      expect(past.body).toMatchObject({ page: 3, pageSize: 15, totalCount: 40 });
      expect(emailsOf(past.body)).toEqual(emailsWhere(SEEDED).slice(30));

      expect((await list(api, { search: SEARCH, page: 0 })).body.page).toBe(1);
      expect((await list(api, { search: 'zz-no-such-user-zz', page: 5 })).body).toMatchObject({ items: [], totalCount: 0, page: 1 });
    });

    test('IDADMIN-23 a host or role filter is not part of the user list any more and changes nothing (QC-775)', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);
      const plain = await list(api, { search: SEARCH, pageSize: 100 });
      const filtered = await list(api, { search: SEARCH, hostId: 1, role: 'Driver', pageSize: 100 });
      expect(filtered.status, filtered.text).toBe(200);
      expect(filtered.body.totalCount).toBe(40);
      expect(emailsOf(filtered.body)).toEqual(emailsOf(plain.body));
      expect(keysOf(filtered.body.items[0])).toEqual(['email', 'firstName', 'isActive', 'lastLoginDate', 'lastName', 'userId']);
    });

    test('IDADMIN-24 totalCount matches Identity for every status, the items match the page, and no password data comes back', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      for (const [status, where] of [['all', '1 = 1'], ['active', 'u.IsActive = 1'], ['deactivated', 'u.IsActive = 0']] as const) {
        const page = await list(api, { status, pageSize: 100 });
        expect(page.body.totalCount, status).toBe(countWhere(where));
        expect(page.body.items, status).toHaveLength(Math.min(100, page.body.totalCount));
        expect(page.body.items.every((item: { isActive: boolean }) => (status === 'all' ? true : item.isActive === (status === 'active'))), status).toBe(true);
      }

      const seededPage = await list(api, { search: SEARCH, status: 'deactivated' });
      expect(emailsOf(seededPage.body)).toEqual([7, 14, 21, 28, 35].map(seeded));

      const admin = (await list(api, { search: seeded(5) })).body;
      expect(admin.totalCount).toBe(1);
      expect(admin.items[0]).toEqual({
        userId: queryIdentityDb(`SELECT Id FROM Users WHERE Email = N'${seeded(5)}'`),
        email: seeded(5),
        firstName: 'E2E',
        lastName: queryIdentityDb(`SELECT LastName FROM Users WHERE Email = N'${seeded(5)}'`),
        isActive: true,
        lastLoginDate: expect.any(String),
      });
      expect(JSON.stringify(seededPage.body)).not.toMatch(SECRET_FIELDS);
    });

    for (const sort of ['email', 'name', 'lastLogin'] as const) {
      test(`IDADMIN-25 sorting by ${sort} both ways pages through every user once, with no repeats or gaps`, async ({ request }) => {
        const api = await IdentityAdminApi.signIn(request);

        for (const dir of ['asc', 'desc'] as const) {
          const seen: string[] = [];
          for (let page = 1; page <= 6; page++) {
            const result = await list(api, { search: SEARCH, sort, dir, page, pageSize: 7 });
            expect(result.body).toMatchObject({ page, pageSize: 7, totalCount: 40 });
            seen.push(...emailsOf(result.body));
          }
          expect(new Set(seen).size, `${sort} ${dir} has no repeats`).toBe(seen.length);
          expect(seen, `${sort} ${dir}`).toEqual(emailsWhere(SEEDED, ORDER[`${sort} ${dir}`]));
        }
      });
    }
  });

  test('IDADMIN-15 the service client secret never appears in an API response or the Identity log', async ({ request }) => {
    test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR).");
    const mark = markIdentityLog();
    const token = await serviceToken(request);
    expect(token.status).toBe(200);
    const api = new IdentityAdminApi(request, token.body.access_token!);

    const responses = [JSON.stringify(token.body)];
    for (const path of ['/users', '/users/list']) {
      responses.push((await api.get(path)).text);
    }

    await expect.poll(() => identityLogSince(mark)).toContain('/connect/token');
    for (const text of [...responses, identityLogSince(mark)]) {
      expect(text).not.toContain(env.adminApiClient!.secret);
    }
  });
});
