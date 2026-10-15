import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { canReadIdentityLog, identityLogSince, markIdentityLog } from '../fixtures/identityLog';
import { HostSignInFlow } from '../pages/HostSignInFlow';
import { ADMIN_API_SCOPE, authorizeRedirect, IdentityAdminApi, serviceToken } from '../pages/IdentityAdminApi';
import { PasswordGrantApi } from '../pages/PasswordGrantApi';
import { env, type OidcClient } from '../config/environment';

const HOST_KEY = 'e2e-qc738';
const WEB_CLIENT: OidcClient = { clientId: 'e2e-qc738.web', redirectUri: 'http://localhost:4200/e2e-qc738' };
const MOBILE_CLIENT_ID = 'e2e-qc738.mobile';
const BRANDING = { displayName: 'E2E QC-738 Host', primaryColor: '#7A1F2B', accentColor: '#F2B134' };
const DEACTIVATION_USER = 'e2e.qc738.deactivate@quarryconnect.test';
const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };
const SECRET_FIELDS = /passwordHash|securityStamp|clientSecret|"secret"/i;

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hostIdOfClient(clientId: string): number {
  return Number(queryIdentityDb(`SELECT HostID FROM app.HostClients WHERE ClientID = ${sqlText(clientId)} AND Active = 1`));
}

function storedGrants(email: string): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.Email = ${sqlText(email)}`));
}

test.describe('Identity administration API (QC-738)', () => {
  test.use(signedOut);
  test.skip(!env.adminApiClient, "Needs Identity's administration service client (ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET).");

  test('IDADMIN-01 the administration API refuses a call with no token or a token it did not issue', async ({ request }) => {
    expect((await new IdentityAdminApi(request, null).get('/hosts')).status).toBe(401);
    expect((await new IdentityAdminApi(request, 'not-a-token').get('/hosts')).status).toBe(401);
  });

  test('IDADMIN-02 a signed-in person cannot use their token on the administration API', async ({ page, request }) => {
    test.skip(!env.hostClient || !env.driver, 'Needs a host client (HOST_CLIENT_ID) and the seeded test driver to get a user token.');
    const flow = new HostSignInFlow(page, env.hostClient!);
    await flow.signIn(env.driver!);
    const token = await flow.exchange(request, await flow.expectCallback());
    expect(token.status, JSON.stringify(token.body)).toBe(200);

    const result = await new IdentityAdminApi(request, token.body.access_token!).get('/hosts');
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

  test('IDADMIN-04 the service token lists hosts but cannot reach the Admin or service clients', async ({ request }) => {
    const api = await IdentityAdminApi.signIn(request);

    const hosts = await api.get('/hosts');
    expect(hosts.status).toBe(200);
    expect(Array.isArray(hosts.body)).toBe(true);

    expect((await api.get(`/clients/${env.adminApiClient!.clientId}`)).status).toBe(404);
    expect((await api.get('/hosts/2147483647')).status).toBe(404);
  });

  test.describe('hosts and clients', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to remove what the API creates, since it has no delete.");

    let hostId = 0;

    test.beforeAll(() => {
      runIdentitySeedScript('identity-admin-api.remove.sql');
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-admin-api.remove.sql');
    });

    test('IDADMIN-05 a host is created and renamed, and a bad or duplicate key is refused', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const invalid = await api.post('/hosts', { hostKey: 'Not A Key' });
      expect(invalid.status).toBe(400);
      expect(invalid.body.errors).toHaveProperty('hostKey');

      const created = await api.post('/hosts', { hostKey: HOST_KEY, displayName: 'E2E QC-738' });
      expect(created.status, created.text).toBe(201);
      expect(created.body).toMatchObject({ hostKey: HOST_KEY, displayName: 'E2E QC-738', isActive: true });
      hostId = created.body.hostId;

      expect((await api.post('/hosts', { hostKey: HOST_KEY })).status).toBe(409);

      const renamed = await api.put(`/hosts/${hostId}`, { hostKey: HOST_KEY, displayName: BRANDING.displayName });
      expect(renamed.status).toBe(200);
      expect((await api.get(`/hosts/${hostId}`)).body.displayName).toBe(BRANDING.displayName);
    });

    test('IDADMIN-06 a host client is created with its URIs and bad input is refused', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);
      const clients = `/hosts/${hostId}/clients`;

      expect((await api.post(clients, { clientId: WEB_CLIENT.clientId })).body.errors).toHaveProperty('clientType');
      expect((await api.post(clients, { clientId: WEB_CLIENT.clientId, clientType: 'Host', redirectUris: ['/relative'] })).body.errors).toHaveProperty('redirectUris');
      expect(
        (await api.post(clients, { clientId: WEB_CLIENT.clientId, clientType: 'Host', redirectUris: [WEB_CLIENT.redirectUri], allowedCorsOrigins: ['http://localhost:4200/path'] })).body.errors,
      ).toHaveProperty('allowedCorsOrigins');
      expect((await api.post(clients, { clientId: MOBILE_CLIENT_ID, clientType: 'MobileDriver', redirectUris: ['http://localhost:4200/'] })).status).toBe(400);
      expect((await api.post(clients, { clientId: env.adminApiClient!.clientId, clientType: 'Host', redirectUris: [WEB_CLIENT.redirectUri] })).status).toBe(409);

      const web = await api.post(clients, {
        clientId: WEB_CLIENT.clientId,
        clientType: 'Host',
        clientName: 'E2E QC-738 web',
        redirectUris: [WEB_CLIENT.redirectUri],
        postLogoutRedirectUris: [WEB_CLIENT.redirectUri],
        allowedCorsOrigins: ['http://localhost:4200'],
      });
      expect(web.status, web.text).toBe(201);
      expect(web.body).toMatchObject({
        hostId,
        clientId: WEB_CLIENT.clientId,
        clientType: 'Host',
        isActive: true,
        redirectUris: [WEB_CLIENT.redirectUri],
        allowedCorsOrigins: ['http://localhost:4200'],
      });

      const mobile = await api.post(clients, { clientId: MOBILE_CLIENT_ID, clientType: 'MobileDriver' });
      expect(mobile.status, mobile.text).toBe(201);
      expect(mobile.body).toMatchObject({ clientType: 'MobileDriver', redirectUris: [] });

      const listed = await api.get(clients);
      expect(listed.body.map((c: { clientId: string }) => c.clientId).sort()).toEqual([WEB_CLIENT.clientId, MOBILE_CLIENT_ID].sort());
      expect(queryIdentityDb(`SELECT STRING_AGG(GrantType, ',') FROM ClientGrantTypes g JOIN Clients c ON c.Id = g.ClientId WHERE c.ClientId = ${sqlText(MOBILE_CLIENT_ID)}`)).toBe('password');
    });

    test('IDADMIN-07 a client that exists only in the database opens the sign-in page at once with its host branding', async ({ page, request }) => {
      const api = await IdentityAdminApi.signIn(request);
      expect((await api.get(`/hosts/${hostId}/branding`)).status).toBe(404);

      const saved = await api.put(`/hosts/${hostId}/branding`, BRANDING);
      expect(saved.status, saved.text).toBe(201);
      expect(saved.body).toMatchObject(BRANDING);

      const flow = new HostSignInFlow(page, WEB_CLIENT);
      await flow.open();
      await expect(page).toHaveURL(/\/Account\/Login/i);
      await expect(page).toHaveTitle(BRANDING.displayName);
    });

    test('IDADMIN-08 a driver who is not mapped to the new host is refused on its sign-in page', async ({ page }) => {
      test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD).');
      const flow = new HostSignInFlow(page, WEB_CLIENT);
      await flow.signIn(env.driver!);
      await flow.expectNoAccess();
    });

    test('IDADMIN-09 updating a client replaces its URIs, and its id and type cannot change', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);
      const path = `/clients/${WEB_CLIENT.clientId}`;
      const callback = `${WEB_CLIENT.redirectUri}/callback`;

      const updated = await api.put(path, { clientName: 'E2E QC-738 web (renamed)', redirectUris: [WEB_CLIENT.redirectUri, callback] });
      expect(updated.status, updated.text).toBe(200);
      expect(updated.body).toMatchObject({ clientName: 'E2E QC-738 web (renamed)', redirectUris: [WEB_CLIENT.redirectUri, callback], allowedCorsOrigins: [] });
      expect((await api.get(path)).body.redirectUris).toEqual([WEB_CLIENT.redirectUri, callback]);

      expect((await api.put(path, { clientType: 'Driver', redirectUris: [WEB_CLIENT.redirectUri] })).body.errors).toHaveProperty('clientType');
      expect((await api.put(path, { clientId: 'e2e-qc738.other', redirectUris: [WEB_CLIENT.redirectUri] })).body.errors).toHaveProperty('clientId');
    });

    test('IDADMIN-10 features switch on and off, and an unknown feature or unsafe branding is refused', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const before = await api.get(`/hosts/${hostId}/features`);
      expect(before.body).toContainEqual({ featureKey: 'maps', isEnabled: false });

      expect((await api.put(`/hosts/${hostId}/features/maps`, { isEnabled: true })).status).toBe(200);
      expect((await api.get(`/hosts/${hostId}/features`)).body).toContainEqual({ featureKey: 'maps', isEnabled: true });
      expect((await api.put(`/hosts/${hostId}/features/maps`, { isEnabled: false })).status).toBe(200);
      expect((await api.get(`/hosts/${hostId}/features`)).body).toContainEqual({ featureKey: 'maps', isEnabled: false });

      expect((await api.put(`/hosts/${hostId}/features/not-a-feature`, { isEnabled: true })).status).toBe(400);
      const unsafe = await api.put(`/hosts/${hostId}/branding`, { displayName: 'x', logoUrl: 'http://insecure.example/logo.png', primaryColor: 'red' });
      expect(unsafe.status).toBe(400);
      expect(Object.keys(unsafe.body.errors).sort()).toEqual(['logoUrl', 'primaryColor']);
      expect((await api.get(`/hosts/${hostId}/branding`)).body).toMatchObject(BRANDING);
    });

    test('IDADMIN-11 deactivating a client stops sign-in through it at once', async ({ page, request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const deactivated = await api.post(`/clients/${WEB_CLIENT.clientId}/deactivate`);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.isActive).toBe(false);
      expect((await api.put(`/clients/${WEB_CLIENT.clientId}`, { redirectUris: [WEB_CLIENT.redirectUri] })).status).toBe(404);

      const flow = new HostSignInFlow(page, WEB_CLIENT);
      await flow.open();
      await flow.expectSignInError('unauthorized_client');
    });

    test('IDADMIN-12 deactivating a host disables every client it has and takes no new ones', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const deactivated = await api.post(`/hosts/${hostId}/deactivate`);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body.isActive).toBe(false);

      const clients = await api.get(`/hosts/${hostId}/clients`);
      expect(clients.body.every((c: { isActive: boolean }) => !c.isActive)).toBe(true);
      expect(queryIdentityDb(`SELECT COUNT(*) FROM Clients WHERE ClientId LIKE 'e2e-qc738.%' AND Enabled = 1`)).toBe('0');

      const added = await api.post(`/hosts/${hostId}/clients`, { clientId: 'e2e-qc738.late', clientType: 'Host', redirectUris: [WEB_CLIENT.redirectUri] });
      expect(added.status).toBe(400);
    });
  });

  test.describe('host users', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to seed the throwaway driver.");
    test.skip(!env.driver || !env.mobileClientId, 'Needs the seeded test driver and the mobile client (MOBILE_CLIENT_ID): the throwaway driver copies the driver password and signs in on the mobile client.');

    test.beforeAll(() => {
      runIdentitySeedScript('identity-deactivation-user.apply.sql', { SourceEmail: env.driver!.email, MobileClientId: env.mobileClientId! });
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-deactivation-user.remove.sql');
    });

    test("IDADMIN-13 a host's users and a user's details show the mapping and no password data", async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);
      const hostId = hostIdOfClient(env.mobileClientId!);

      const users = await api.get(`/hosts/${hostId}/users`);
      expect(users.status).toBe(200);
      const listed = users.body.find((u: { email: string }) => u.email === DEACTIVATION_USER);
      expect(listed).toMatchObject({ isActive: true, role: 'Driver', organisationId: 1, isHostAdmin: false });

      const details = await api.get(`/users/${listed.userId}`);
      expect(details.status).toBe(200);
      expect(details.body).toMatchObject({ email: DEACTIVATION_USER, isActive: true, platformRoles: [] });
      expect(details.body.hosts).toContainEqual(expect.objectContaining({ hostId, role: 'Driver' }));
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

  test('IDADMIN-15 the service client secret never appears in an API response or the Identity log', async ({ request }) => {
    test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR).");
    const mark = markIdentityLog();
    const token = await serviceToken(request);
    expect(token.status).toBe(200);
    const api = new IdentityAdminApi(request, token.body.access_token!);

    const responses = [JSON.stringify(token.body)];
    for (const path of ['/hosts', `/clients/${env.adminApiClient!.clientId}`]) {
      responses.push((await api.get(path)).text);
    }

    await expect.poll(() => identityLogSince(mark)).toContain('/connect/token');
    for (const text of [...responses, identityLogSince(mark)]) {
      expect(text).not.toContain(env.adminApiClient!.secret);
    }
  });
});
