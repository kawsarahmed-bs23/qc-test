// QC-986 (replaces the QC-909 host model): the Host keeps no agreement text. auth.UserEULADocs holds one row per version
// and the live row only refers to the website; SignUserEULA returns the live version and its date; Accept stores the live
// doc id and version with no text; the sign-in check passes only for an acceptance of the live version.
// Local only. Host cases (TERMS-*) are API-level against APP_API_URL and run as e2e.qc909.* throwaway host admins seeded
// by seed/identity-qc909-user.apply.sql + seed/host-qc909-user.apply.sql and removed with every acceptance they make.
// They need the QC-986 Version 2 migration (an earlier, no longer live version must exist).
// QC-909 Driver cases (DEULA-*) run as DRIVER_EMAIL against DRIVERS_API_URL; they only run when that driver has no
// app.DriverSignedEulas row, and remove every row they add. They change with QC-988.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { HostAccountApi, identityAccessToken } from '@api/host-account.api';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import {
  DRIVER_APP_HOST_NAME,
  DriverEulaApi,
  HOST_NAME_TOKEN,
  HostEulaApi,
  driverEulaRows,
  hostSignedEulas,
  liveDriverEula,
  liveHostEula,
  liveHostTerms,
  moveAcceptanceToVersion,
  previousHostTerms,
  remainingQc909Rows,
  removeDriverEulaAcceptances,
  removeQc909HostUsers,
  seedQc909HostUser,
  type HostTermsVersion,
} from '@api/host-name-eula.api';
import { newDriverUiSession } from '@pages/driver-eula.page';

test.describe('Host Terms of Use and Privacy Policy: version check, no agreement text (QC-986)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canSeedLocalDb() || !canUseIdentityDb() || !env.admin || !env.appApiUrl || !env.hostClient,
    "Needs the host's and Identity's local databases, ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users, APP_API_URL and HOST_CLIENT_ID.",
  );

  let api: HostEulaApi;
  let live: HostTermsVersion;
  let previous: HostTermsVersion;
  let fresh: ThrowawayUser;
  let older: ThrowawayUser;
  let current: ThrowawayUser;
  const tokens: Record<'fresh' | 'older' | 'current', string> = { fresh: '', older: '', current: '' };

  test.beforeAll(async ({ browser, playwright }) => {
    test.setTimeout(300_000);
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const probe = await request.get(`${env.appApiUrl}/api/Account/CheckUserEULASign`).catch(() => null);
    test.skip(probe?.status() !== 401, `The host API (APP_API_URL ${env.appApiUrl}) is not running.`);
    api = new HostEulaApi(request);

    live = liveHostTerms();
    const earlier = previousHostTerms();
    test.skip(!earlier, 'The host database has only one version; the QC-986 Version 2 migration has not run.');
    previous = earlier!;

    removeQc909HostUsers();
    fresh = seedQc909HostUser('fresh', 'none');
    older = seedQc909HostUser('older', 'accepted');
    current = seedQc909HostUser('current', 'accepted');
    moveAcceptanceToVersion(older.userId, previous);

    for (const [key, user] of [
      ['fresh', fresh],
      ['older', older],
      ['current', current],
    ] as const) {
      const context = await browser.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
      try {
        const identityToken = await identityAccessToken(await context.newPage(), request, user, user.authenticatorKey);
        const exchange = await new HostAccountApi(request).identityExchange(identityToken);
        expect(exchange.status, `identityexchange for ${user.email}`).toBe(200);
        tokens[key] = exchange.data!.accessToken;
      } finally {
        await context.close();
      }
    }
  });

  test.afterAll(() => {
    removeQc909HostUsers();
    expect(remainingQc909Rows()).toEqual({ hostUsers: 0, acceptances: 0, identityUsers: 0 });
  });

  test('TERMS-01 SignUserEULA returns the live version and its date as MM/dd/yyyy, with no agreement text', async () => {
    const result = await api.signUserEula(tokens.fresh);

    expect(result.status).toBe(200);
    expect(result.body.data?.userEULADocId).toBe(live.docId);
    expect(result.body.data?.eulaVersion).toBe(live.version);
    expect(result.body.data?.termsUpdatedOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(result.body.data?.termsUpdatedOn, 'the date is the ActiveDate as stored').toBe(live.updatedOn);
    expect(result.body.data).not.toHaveProperty('userEULADocText');
    expect(liveHostEula().text, 'the live row holds only the reference').toBe('See quarryconnect.com/terms and quarryconnect.com/privacy for language');
  });

  test('TERMS-02 a user with no acceptance is asked to accept', async () => {
    expect(await api.hasSignedLatest(tokens.fresh)).toBe(false);
    expect(hostSignedEulas(fresh.userId)).toEqual([]);
  });

  test('TERMS-03 a user who accepted only an earlier version is asked to accept', async () => {
    expect(hostSignedEulas(older.userId).map((row) => row.version)).toEqual([previous.version]);
    expect(await api.hasSignedLatest(tokens.older)).toBe(false);
  });

  test('TERMS-04 a user who accepted the live version is not asked', async () => {
    expect(hostSignedEulas(current.userId).map((row) => row.version)).toEqual([live.version]);
    expect(await api.hasSignedLatest(tokens.current)).toBe(true);
  });

  test('TERMS-05 Accept ignores a tampered body and stores the live doc id and version with no text', async () => {
    const result = await api.accept(tokens.fresh, { userEULADocId: 999, eulaVersion: '9.9', userEULADocText: 'TAMPERED', userId: current.userId });

    expect(result.status).toBe(200);
    expect(result.body.data).toBe(true);
    const rows = hostSignedEulas(fresh.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].docId).toBe(live.docId);
    expect(rows[0].version).toBe(live.version);
    expect(rows[0].text, 'no agreement text is stored with the acceptance').toBeNull();
    expect(hostSignedEulas(current.userId), "the body's userId does not sign for another user").toHaveLength(1);
    expect(await api.hasSignedLatest(tokens.fresh)).toBe(true);
  });

  test('TERMS-06 accepting after an earlier version adds a new row and keeps the old one; accepting again adds nothing', async () => {
    expect((await api.accept(tokens.older, {})).body.data).toBe(true);
    expect((await api.accept(tokens.older, {})).body.data).toBe(true);

    const rows = hostSignedEulas(older.userId);
    expect(rows.map((row) => row.version).sort()).toEqual([previous.version, live.version].sort());
    expect(await api.hasSignedLatest(tokens.older)).toBe(true);
  });

  for (const [name, route, website] of [
    ['TERMS-07', '/legal/terms', 'https://www.quarryconnect.com/terms'],
    ['TERMS-08', '/legal/privacy', 'https://www.quarryconnect.com/privacy'],
  ] as const) {
    test(`${name} ${route} leaves the Host site for ${website}`, async ({ browser }) => {
      test.skip(!env.appUrl, 'APP_URL is not set.');
      const context = await browser.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
      try {
        const page = await context.newPage();
        await page.route('https://www.quarryconnect.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>website</h1>' }));
        await page.goto(`${env.appUrl}/#${route}`);
        await expect(page).toHaveURL(website, { timeout: 30_000 });
      } finally {
        await context.close();
      }
    });
  }
});

test.describe('Driver App EULA from the drivers API (QC-909)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canUseDriversDb() || !env.driver || !env.driversApiUrl || !env.mobileClientId,
    'Needs DRIVERS_SQL_DATABASE, DRIVER_EMAIL / DRIVER_PASSWORD, DRIVERS_API_URL and MOBILE_CLIENT_ID.',
  );

  let api: DriverEulaApi;
  let accessToken = '';
  let driverId = '';
  let live: { eulaUuid: string; version: string };

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
    api = new DriverEulaApi(request);
    live = liveDriverEula();

    const grant = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
    expect(grant.status, grant.body.error ?? '').toBe(200);
    accessToken = grant.body.access_token!;
    driverId = String(decodeJwt(accessToken).claims['sub']);
    test.skip(driverEulaRows(driverId).count !== 0, 'The test driver already has a Driver App EULA acceptance that these cases did not make.');
  });

  test.afterAll(() => {
    if (!driverId) return;
    removeDriverEulaAcceptances(driverId);
    expect(driverEulaRows(driverId).count, 'no Driver App EULA acceptance is left for the test driver').toBe(0);
  });

  test('DEULA-01 GET /eula without a token is 401', async () => {
    expect((await api.latest(null)).status).toBe(401);
  });

  test('DEULA-02 GET /eula shows the live Driver App EULA naming Quarry Connect, with no token, not yet accepted', async () => {
    const result = await api.latest(accessToken);

    expect(result.status).toBe(200);
    expect(result.body.data?.eulaUuid.toLowerCase()).toBe(live.eulaUuid);
    expect(result.body.data?.version).toBe(live.version);
    expect(result.body.data?.text).toContain(DRIVER_APP_HOST_NAME);
    expect(result.body.data?.text).not.toContain(HOST_NAME_TOKEN);
    expect(result.body.data?.accepted).toBe(false);
  });

  test('DEULA-03 accepting with a wrong or empty eulaUuid is 400 on EulaUuid and stores nothing', async () => {
    for (const body of [{ eulaUuid: '00000000-0000-0000-0000-000000000001' }, {}]) {
      const result = await api.accept(accessToken, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      expect(Object.keys(result.body.validationErrors ?? {}).map((key) => key.toLowerCase())).toContain('eulauuid');
    }
    expect(driverEulaRows(driverId).count).toBe(0);
  });

  test('DEULA-04 accepting the live eulaUuid is 200 and stores one acceptance with the filled text', async () => {
    const result = await api.accept(accessToken, { eulaUuid: live.eulaUuid });

    expect(result.status).toBe(200);
    expect(result.body.data?.accepted).toBe(true);
    expect(driverEulaRows(driverId)).toEqual({ count: 1, filledTexts: 1, tokenTexts: 0 });
  });

  test('DEULA-05 accepting again is idempotent: still 200 and one acceptance', async () => {
    const result = await api.accept(accessToken, { eulaUuid: live.eulaUuid });

    expect(result.status).toBe(200);
    expect(result.body.data?.accepted).toBe(true);
    expect(driverEulaRows(driverId).count).toBe(1);
  });

  test('DEULA-06 GET /eula reports accepted after the accept', async () => {
    const result = await api.latest(accessToken);

    expect(result.status).toBe(200);
    expect(result.body.data?.accepted).toBe(true);
  });

  test('DEULA-07 a driver without an acceptance lands on the Driver UI EULA, sees Quarry Connect, accepts and reaches home', async ({
    browser,
    playwright,
  }) => {
    test.skip(!env.driverUiClient, 'DRIVER_UI_CLIENT_ID / DRIVER_UI_REDIRECT_URI are not set.');
    const probe = await playwright.request.newContext();
    const driverUiUp = await probe
      .get(env.driverUiClient!.redirectUri, { timeout: 10_000 })
      .then((response) => response.ok())
      .catch(() => false);
    await probe.dispose();
    test.skip(!driverUiUp, `The Driver UI (${env.driverUiClient!.redirectUri}) is not running.`);

    removeDriverEulaAcceptances(driverId);
    const { context, eula } = await newDriverUiSession(browser);
    try {
      await eula.signIn(env.driver!);
      await eula.expectShown();
      await eula.expectTextNames(DRIVER_APP_HOST_NAME);
      await eula.accept.click();
      await eula.expectPastTheEula();
      expect(driverEulaRows(driverId).count).toBe(1);
    } finally {
      await context.close();
    }
  });
});
