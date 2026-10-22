import { randomUUID } from 'crypto';
import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { canReadIdentityLog, identityLogSince, markIdentityLog } from '../fixtures/identityLog';
import { HostSignInFlow } from '../pages/HostSignInFlow';
import { IdentityAdminApi } from '../pages/IdentityAdminApi';
import { decodeJwt, PasswordGrantApi, type TokenResponse, type TokenResult } from '../pages/PasswordGrantApi';
import { IdentityRootLanding, NoHostPage, SELECT_HOST_INVALID, SelectHostPage } from '../pages/SelectHostPage';
import { env, type Credentials } from '../config/environment';

const SECOND_HOST_KEY = 'statewide-materials';
const DRIVER_UI_SCOPES = 'openid profile email quarryconnect.drivers.api';
const CHANGED_PASSWORD = 'Hsel665-Changed-Pass!';
const WEAK_PASSWORD = 'weak';
const INVALID_CREDENTIALS = { error: 'invalid_grant', error_description: 'invalid_username_or_password' };
const NO_HOST_AVAILABLE = { error: 'invalid_grant', error_description: 'no_host_available' };
const GRANT_THROTTLE_LINE = 'Password grant refused: too many attempts';
const GRANT_THROTTLED =
  "Identity's per-IP password-grant throttle (20 per 15 minutes) is spent by the earlier specs in this run; run the HSEL cases on their own after restarting Identity.";
const HOST_KEY_PREFIX = 'e2e-qc665';

type SeedUser = 'driver0' | 'driver1' | 'driver2' | 'host1' | 'host2';

function email(user: SeedUser): string {
  return `e2e.qc665.${user}@quarryconnect.test`;
}

function credentials(user: SeedUser): Credentials {
  return { email: email(user), password: env.driver!.password };
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function seedUsers(): void {
  runIdentitySeedScript('identity-qc665-users.apply.sql', {
    SourceEmail: env.driver!.email,
    MobileClientId: env.mobileClientId!,
    SecondHostKey: SECOND_HOST_KEY,
  });
}

function mobileHostId(): number {
  return Number(queryIdentityDb(`SELECT HostID FROM app.HostClients WHERE ClientID = ${sqlText(env.mobileClientId!)} AND Active = 1`));
}

function secondHostId(): number {
  return Number(queryIdentityDb(`SELECT HostID FROM app.Hosts WHERE HostKey = ${sqlText(SECOND_HOST_KEY)}`));
}

function hostUuid(hostId: number): string {
  return queryIdentityDb(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostID = ${hostId}`)!;
}

function hostUiUrl(hostId: number): string {
  const redirectUri = queryIdentityDb(
    `SELECT TOP 1 r.RedirectUri FROM app.HostClients hc JOIN Clients c ON c.ClientId = hc.ClientID JOIN ClientRedirectUris r ON r.ClientId = c.Id ` +
      `WHERE hc.HostID = ${hostId} AND hc.ClientTypeID = 1 AND hc.Active = 1 ORDER BY hc.HostClientID, r.Id`,
  );
  expect(redirectUri, `host ${hostId} has an active Host client with a redirect URI`).not.toBeNull();
  return `${new URL(redirectUri!).origin}/`;
}

function userId(user: SeedUser): string {
  return queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(${sqlText(email(user))})`)!;
}

function hostsOf(body: TokenResponse): string[] {
  return (body.hosts ?? []).map((h) => h.host_uuid.toLowerCase()).sort();
}

function claimsOf(body: TokenResponse): Record<string, unknown> {
  expect(body.access_token, JSON.stringify({ ...body, access_token: undefined, refresh_token: undefined })).toBeTruthy();
  return decodeJwt(body.access_token!).claims;
}

async function grant(call: () => Promise<TokenResult>): Promise<TokenResult> {
  const mark = markIdentityLog();
  const result = await call();
  test.skip(identityLogSince(mark).includes(GRANT_THROTTLE_LINE), GRANT_THROTTLED);
  return result;
}

test.describe('Host selection after sign-in (QC-665)', () => {
  test.use(signedOut);
  test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to seed the e2e.qc665 users and their host mappings.");
  test.skip(!env.driver, "Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD): the e2e.qc665 users copy its password hash.");
  test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');

  let first = '';
  let second = '';

  test.beforeAll(() => {
    first = hostUuid(mobileHostId());
    second = hostUuid(secondHostId());
  });

  test.afterAll(() => {
    runIdentitySeedScript('identity-qc665.remove.sql');
  });

  test.describe('Driver UI and host users in the browser', () => {
    test.skip(!env.driverUiClient, 'The Driver UI client is not configured for this environment (DRIVER_UI_CLIENT_ID / DRIVER_UI_REDIRECT_URI).');

    test.beforeAll(() => {
      seedUsers();
    });

    test('HSEL-01 a driver with two hosts picks one and the Driver UI token carries it even when the code exchange names another host, and a second authorize skips the picker', async ({ page, request }) => {
      const flow = new HostSignInFlow(page, env.driverUiClient!, DRIVER_UI_SCOPES);
      await flow.signIn(credentials('driver2'));

      const picker = new SelectHostPage(page);
      await picker.expectVisible();
      expect(await picker.hostUuids()).toEqual([first, second].sort());
      await picker.choose(second);

      const token = await flow.exchange(request, await flow.expectCallback(), { host: first });
      expect(token.status, JSON.stringify(token.body.error)).toBe(200);
      expect(token.body).not.toHaveProperty('hosts');
      const claims = claimsOf(token.body);
      expect(String(claims.host_uuid).toLowerCase()).toBe(second);
      expect(claims.role).toBe('Driver');

      const again = new HostSignInFlow(page, env.driverUiClient!, DRIVER_UI_SCOPES);
      await again.open();
      expect(String((await again.accessTokenClaims(request)).host_uuid).toLowerCase()).toBe(second);
    });

    test('HSEL-02 picking a host that is not in the list is refused and the picker stays', async ({ page }) => {
      const flow = new HostSignInFlow(page, env.driverUiClient!, DRIVER_UI_SCOPES);
      await flow.signIn(credentials('driver2'));

      const picker = new SelectHostPage(page);
      await picker.expectVisible();
      await picker.chooseUnlisted(randomUUID());

      await expect(picker.error).toHaveText(SELECT_HOST_INVALID);
      await picker.expectVisible();
      expect(await picker.hostUuids()).toEqual([first, second].sort());
    });

    test('HSEL-03 a driver with one host goes straight to the Driver UI with that host', async ({ page, request }) => {
      const flow = new HostSignInFlow(page, env.driverUiClient!, DRIVER_UI_SCOPES);
      await flow.signIn(credentials('driver1'));

      const claims = await flow.accessTokenClaims(request);
      expect(String(claims.host_uuid).toLowerCase()).toBe(first);
      expect(claims.role).toBe('Driver');
    });

    test('HSEL-04 a driver with no host sees No host available', async ({ page }) => {
      const flow = new HostSignInFlow(page, env.driverUiClient!, DRIVER_UI_SCOPES);
      await flow.signIn(credentials('driver0'));

      await new NoHostPage(page).expectVisible();
    });

    test('HSEL-05 a host user with two hosts at the Identity root picks one and lands on that host', async ({ page }) => {
      const landing = new IdentityRootLanding(page);
      await landing.signIn(credentials('host2'));

      const picker = new SelectHostPage(page);
      await picker.expectVisible();
      expect(await picker.hostUuids()).toEqual([first, second].sort());
      await picker.choose(second);

      await landing.expectLandedOn(hostUiUrl(secondHostId()));
    });

    test('HSEL-06 a host user with one host at the Identity root goes straight to it', async ({ page }) => {
      const landing = new IdentityRootLanding(page);
      await landing.signIn(credentials('host1'));

      await landing.expectLandedOn(hostUiUrl(mobileHostId()));
    });

    test('HSEL-07 a host user signing in through a host client never sees the picker', async ({ page }) => {
      test.skip(!env.hostClient, 'Needs a host client (HOST_CLIENT_ID / HOST_REDIRECT_URI).');
      const flow = new HostSignInFlow(page, env.hostClient!);
      await flow.signIn(credentials('host2'));

      await flow.expectCallback();
      await expect(new SelectHostPage(page).list).toHaveCount(0);
    });
  });

  test.describe('mobile token endpoint and drivers API', () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR) to tell the password-grant throttle from a real refusal.");

    const issued: Partial<Record<'driver1' | 'driver2' | 'driver2Picked', TokenResponse>> = {};

    test.beforeAll(() => {
      seedUsers();
    });

    test('HSEL-08 a driver with no host is refused with no_host_available only after the right password, with no hosts', async ({ request }) => {
      const api = new PasswordGrantApi(request);

      const wrong = await grant(() => api.passwordGrant(email('driver0'), `${env.driver!.password}x`));
      expect(wrong.status).toBe(400);
      expect(wrong.body).toEqual(INVALID_CREDENTIALS);

      const right = await grant(() => api.passwordGrant(email('driver0'), env.driver!.password));
      expect(right.status).toBe(400);
      expect(right.body).toEqual(NO_HOST_AVAILABLE);
    });

    test('HSEL-09 a driver with one host gets a one-element hosts array and a token for that host with the profile claims', async ({ request }) => {
      const result = await grant(() => new PasswordGrantApi(request).passwordGrant(email('driver1'), env.driver!.password));
      expect(result.status, JSON.stringify(result.body.error)).toBe(200);
      issued.driver1 = result.body;

      expect(result.body.hosts).toHaveLength(1);
      expect(Object.keys(result.body.hosts![0]).sort()).toEqual(['display_name', 'host_uuid', 'logo_url']);
      expect(hostsOf(result.body)).toEqual([first]);

      const claims = claimsOf(result.body);
      expect(String(claims.host_uuid).toLowerCase()).toBe(first);
      expect(claims).toMatchObject({
        role: 'Driver',
        email: email('driver1'),
        given_name: 'E2E',
        family_name: 'QC-665 driver1',
      });
      expect(claims.name).toBeTruthy();
    });

    test('HSEL-10 a driver with two hosts gets both in hosts and a Driver token with no host yet', async ({ request }) => {
      const result = await grant(() => new PasswordGrantApi(request).passwordGrant(email('driver2'), env.driver!.password));
      expect(result.status, JSON.stringify(result.body.error)).toBe(200);
      issued.driver2 = result.body;

      expect(hostsOf(result.body)).toEqual([first, second].sort());
      const claims = claimsOf(result.body);
      expect(claims).not.toHaveProperty('host_uuid');
      expect(claims.role).toBe('Driver');
    });

    test('HSEL-11 the drivers API shows no host and refuses /me/host for a token with no host', async ({ request }) => {
      test.skip(!env.driversApiUrl, 'The drivers API is not configured for this environment (DRIVERS_API_URL).');
      test.skip(!issued.driver2, GRANT_THROTTLED);
      const api = new PasswordGrantApi(request);

      const me = await api.driversMe(issued.driver2!.access_token!);
      expect(me.status()).toBe(200);
      expect((await me.json()).data).toMatchObject({ hostUuid: null, role: 'Driver', email: email('driver2') });

      expect((await api.driversMeHost(issued.driver2!.access_token!)).status()).toBe(403);
    });

    test('HSEL-12 a refresh with host picks it, a plain refresh keeps it, and asking for another host is refused', async ({ request }) => {
      test.skip(!issued.driver2, GRANT_THROTTLED);
      const api = new PasswordGrantApi(request);

      const picked = await api.refresh(issued.driver2!.refresh_token!, second);
      expect(picked.status, JSON.stringify(picked.body.error)).toBe(200);
      expect(String(claimsOf(picked.body).host_uuid).toLowerCase()).toBe(second);
      expect(hostsOf(picked.body)).toEqual([first, second].sort());

      const kept = await api.refresh(picked.body.refresh_token!);
      expect(kept.status, JSON.stringify(kept.body.error)).toBe(200);
      expect(String(claimsOf(kept.body).host_uuid).toLowerCase()).toBe(second);
      expect(hostsOf(kept.body)).toEqual([first, second].sort());
      issued.driver2Picked = kept.body;

      const switched = await api.refresh(kept.body.refresh_token!, first);
      expect(switched.status).toBe(400);
      expect(switched.body).toEqual({ error: 'invalid_grant' });
    });

    test('HSEL-13 the drivers API reads the host only from the token and ignores a host named in a header or the query', async ({ request }) => {
      test.skip(!env.driversApiUrl, 'The drivers API is not configured for this environment (DRIVERS_API_URL).');
      test.skip(!issued.driver2Picked, GRANT_THROTTLED);
      const api = new PasswordGrantApi(request);
      const token = issued.driver2Picked!.access_token!;
      const claims = claimsOf(issued.driver2Picked!);
      const forged = { 'X-Host-Key': 'default', 'X-Host': first, 'X-Host-Uuid': first };

      const fromHeaders = await api.driversMe(token, { headers: forged });
      expect(fromHeaders.status()).toBe(200);
      expect((await fromHeaders.json()).data).toMatchObject({
        hostUuid: second,
        userUuid: claims.sub,
        role: 'Driver',
        email: email('driver2'),
        firstName: 'E2E',
        lastName: 'QC-665 driver2',
        fullName: claims.name,
      });

      const fromQuery = await api.driversMe(token, { query: { host: first, hostUuid: first } });
      expect((await fromQuery.json()).data.hostUuid).toBe(second);

      const host = await api.driversMeHost(token, { headers: forged, query: { host: first } });
      expect(host.status()).toBe(200);
      expect((await host.json()).data).toEqual({ hostUuid: second });
    });

    test('HSEL-14 the password grant with host scopes the token in one step', async ({ request }) => {
      const result = await grant(() => new PasswordGrantApi(request).passwordGrant(email('driver2'), env.driver!.password, second));
      expect(result.status, JSON.stringify(result.body.error)).toBe(200);
      expect(String(claimsOf(result.body).host_uuid).toLowerCase()).toBe(second);
      expect(hostsOf(result.body)).toEqual([first, second].sort());
    });

    test("HSEL-15 a host the driver is not mapped to, an unknown host and a malformed value are refused exactly like a wrong password", async ({ request }) => {
      const api = new PasswordGrantApi(request);

      for (const [user, host] of [
        ['driver1', second],
        ['driver2', randomUUID()],
        ['driver2', 'not-a-guid'],
      ] as const) {
        const result = await grant(() => api.passwordGrant(email(user), env.driver!.password, host));
        expect(result.status, `${user} host=${host}`).toBe(400);
        expect(result.body, `${user} host=${host}`).toEqual(INVALID_CREDENTIALS);
      }
    });

    test('HSEL-16 the change-password grant honours host and returns hosts, and a rejected password carries no hosts', { tag: '@write' }, async ({ request }) => {
      const api = new PasswordGrantApi(request);

      const changed = await grant(() => api.changePassword(email('driver2'), env.driver!.password, CHANGED_PASSWORD, first));
      expect(changed.status, JSON.stringify(changed.body.error_description)).toBe(200);
      expect(String(claimsOf(changed.body).host_uuid).toLowerCase()).toBe(first);
      expect(hostsOf(changed.body)).toEqual([first, second].sort());

      const rejected = await grant(() => api.changePassword(email('driver2'), CHANGED_PASSWORD, WEAK_PASSWORD));
      expect(rejected.status).toBe(400);
      expect(rejected.body.error_description).toBe('password_rejected');
      expect(rejected.body).not.toHaveProperty('hosts');
    });

    test('HSEL-17 a refresh recomputes hosts, is refused once the driver leaves the chosen host, and a driver left with no host gets no_host_available', { tag: '@write' }, async ({ request }) => {
      test.skip(!issued.driver1, GRANT_THROTTLED);
      const api = new PasswordGrantApi(request);
      const driver = sqlText(userId('driver1'));

      queryIdentityDb(
        `INSERT app.UserHosts (UserID, HostID, OrganisationID, RoleID, CreatedBy, UpdatedBy) SELECT ${driver}, ${secondHostId()}, 1, Id, N'e2e', N'e2e' FROM Roles WHERE Name = N'Driver'`,
      );
      const recomputed = await api.refresh(issued.driver1!.refresh_token!);
      expect(recomputed.status, JSON.stringify(recomputed.body.error)).toBe(200);
      expect(hostsOf(recomputed.body)).toEqual([first, second].sort());
      expect(String(claimsOf(recomputed.body).host_uuid).toLowerCase()).toBe(first);

      queryIdentityDb(`UPDATE app.UserHosts SET Active = 0 WHERE UserID = ${driver} AND HostID = ${mobileHostId()}`);
      const refused = await api.refresh(recomputed.body.refresh_token!);
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_grant');
      expect(refused.body).not.toHaveProperty('hosts');

      queryIdentityDb(`UPDATE app.UserHosts SET Active = 0 WHERE UserID = ${driver}`);
      const none = await grant(() => api.passwordGrant(email('driver1'), env.driver!.password));
      expect(none.status).toBe(400);
      expect(none.body).toEqual(NO_HOST_AVAILABLE);
    });
  });

  test.describe("Identity administration API hosts' UUID", { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!env.adminApiClient, "Needs Identity's administration service client (ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET).");

    const created: { withUuid: number; generated: number; uuid: string } = { withUuid: 0, generated: 0, uuid: randomUUID() };

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc665.remove.sql');
    });

    test('HSEL-18 hosts carry their UUID, a new host keeps a given UUID or gets a fresh one, and a UUID in use is refused', async ({ request }) => {
      const api = await IdentityAdminApi.signIn(request);

      const list = await api.get('/hosts');
      expect(list.status).toBe(200);
      for (const host of list.body) {
        expect(host.hostUuid, host.hostKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
        expect(host.hostUuid, host.hostKey).not.toBe('00000000-0000-0000-0000-000000000000');
      }
      const mobileHost = list.body.find((h: { hostId: number }) => h.hostId === mobileHostId());
      expect(mobileHost.hostUuid.toLowerCase()).toBe(first);
      expect((await api.get(`/hosts/${mobileHostId()}`)).body.hostUuid.toLowerCase()).toBe(first);

      const withUuid = await api.post('/hosts', { hostKey: `${HOST_KEY_PREFIX}-a`, displayName: 'E2E QC-665 A', hostUuid: created.uuid });
      expect(withUuid.status, withUuid.text).toBe(201);
      expect(withUuid.body.hostUuid).toBe(created.uuid);
      created.withUuid = withUuid.body.hostId;

      const generated = await api.post('/hosts', { hostKey: `${HOST_KEY_PREFIX}-b`, displayName: 'E2E QC-665 B' });
      expect(generated.status, generated.text).toBe(201);
      expect(generated.body.hostUuid).toMatch(/^[0-9a-f-]{36}$/i);
      expect(generated.body.hostUuid).not.toBe('00000000-0000-0000-0000-000000000000');
      expect(generated.body.hostUuid).not.toBe(created.uuid);
      created.generated = generated.body.hostId;

      expect((await api.post('/hosts', { hostKey: `${HOST_KEY_PREFIX}-c`, hostUuid: first })).status).toBe(409);
      expect((await api.post('/hosts', { hostKey: `${HOST_KEY_PREFIX}-c`, hostUuid: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    });

    test("HSEL-19 updating a host sets a new UUID, keeps it when none is sent, and refuses another host's or an empty one", async ({ request }) => {
      test.skip(!created.withUuid, 'HSEL-18 did not create the host.');
      const api = await IdentityAdminApi.signIn(request);
      const path = `/hosts/${created.withUuid}`;
      const base = { hostKey: `${HOST_KEY_PREFIX}-a`, displayName: 'E2E QC-665 A' };

      expect((await api.put(path, { ...base, hostUuid: first })).status).toBe(409);
      expect((await api.put(path, { ...base, hostUuid: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
      expect((await api.get(path)).body.hostUuid).toBe(created.uuid);

      const kept = await api.put(path, base);
      expect(kept.status, kept.text).toBe(200);
      expect(kept.body.hostUuid).toBe(created.uuid);

      const fresh = randomUUID();
      const changed = await api.put(path, { ...base, hostUuid: fresh });
      expect(changed.status, changed.text).toBe(200);
      expect(changed.body.hostUuid).toBe(fresh);
      expect((await api.get(path)).body.hostUuid).toBe(fresh);
    });
  });
});
