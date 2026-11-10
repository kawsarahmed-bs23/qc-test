// QC-909: the user EULA names the Host through a {{HostName}} token. The host API fills it with the Host organisation's
// name (HTML-encoded) in SignUserEULA and stores the live doc's id, version and filled text on Accept, whatever the
// client sends. The drivers API serves its own Driver App EULA with {{HostName}} filled as "Quarry Connect".
// Local only. Host cases (HEULA-*) are API-level against APP_API_URL and run as e2e.qc909.* throwaway host admins seeded
// by seed/identity-qc909-user.apply.sql + seed/host-qc909-user.apply.sql and removed with every acceptance they make.
// The QC-909 migration (seed/host-qc909-eula-token.apply.sql) is applied only for these cases, and only when the live
// EULA has no token yet; its rollback always runs after them and the text's SHA-256 must be back to the original.
// Driver cases (DEULA-*) run as DRIVER_EMAIL against DRIVERS_API_URL; they only run when that driver has no
// app.DriverSignedEulas row, and remove every row they add.
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
  applyHostNameToken,
  driverEulaRows,
  hostOrganisationName,
  hostSignedEulas,
  htmlEncode,
  liveDriverEula,
  liveHostEula,
  remainingQc909Rows,
  removeDriverEulaAcceptances,
  removeQc909HostUsers,
  rollBackHostNameToken,
  seedQc909HostUser,
  type LiveHostEula,
} from '@api/host-name-eula.api';
import { newDriverUiSession } from '@pages/driver-eula.page';

test.describe('Host EULA names the Host through {{HostName}} (QC-909)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canSeedLocalDb() || !canUseIdentityDb() || !env.admin || !env.appApiUrl || !env.hostClient,
    "Needs the host's and Identity's local databases, ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users, APP_API_URL and HOST_CLIENT_ID.",
  );

  let api: HostEulaApi;
  let original: LiveHostEula;
  let tokenApplied = false;
  let tokenized: LiveHostEula;
  let filledText: string;
  let fresh: ThrowawayUser;
  let prior: ThrowawayUser;
  const tokens: Record<'fresh' | 'prior', string> = { fresh: '', prior: '' };

  test.beforeAll(async ({ browser, playwright }) => {
    test.setTimeout(240_000);
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const probe = await request.get(`${env.appApiUrl}/api/Account/CheckUserEULASign`).catch(() => null);
    test.skip(probe?.status() !== 401, `The host API (APP_API_URL ${env.appApiUrl}) is not running.`);
    api = new HostEulaApi(request);

    removeQc909HostUsers();
    fresh = seedQc909HostUser('fresh', 'none');
    prior = seedQc909HostUser('prior', 'accepted');
    for (const [key, user] of [
      ['fresh', fresh],
      ['prior', prior],
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

    original = liveHostEula();
    if (!original.text.includes(HOST_NAME_TOKEN)) {
      tokenApplied = true;
      applyHostNameToken();
    }
    tokenized = liveHostEula();
    filledText = tokenized.text.split(HOST_NAME_TOKEN).join(htmlEncode(hostOrganisationName()));
  });

  test.afterAll(() => {
    try {
      if (tokenApplied) {
        rollBackHostNameToken();
        expect(liveHostEula().sha256, 'the live EULA text is back to its original SHA-256').toBe(original.sha256);
      }
    } finally {
      removeQc909HostUsers();
      expect(remainingQc909Rows()).toEqual({ hostUsers: 0, acceptances: 0, identityUsers: 0 });
    }
  });

  test('HEULA-01 SignUserEULA returns the live EULA with {{HostName}} filled by the Host organisation name', async () => {
    expect(tokenized.text, 'the live EULA uses the token while these cases run').toContain(HOST_NAME_TOKEN);

    const result = await api.signUserEula(tokens.fresh);

    expect(result.status).toBe(200);
    expect(result.body.data?.userEULADocId).toBe(tokenized.docId);
    expect(result.body.data?.eulaVersion).toBe(tokenized.version);
    expect(result.body.data?.userEULADocText).not.toContain(HOST_NAME_TOKEN);
    expect(result.body.data?.userEULADocText).toContain(htmlEncode(hostOrganisationName()));
    expect(result.body.data?.userEULADocText).toBe(filledText);
  });

  test('HEULA-02 a user who never accepted is not signed', async () => {
    expect(await api.hasSignedLatest(tokens.fresh)).toBe(false);
    expect(hostSignedEulas(fresh.userId)).toEqual([]);
  });

  test('HEULA-03 Accept ignores a tampered body and stores the live doc id, version and the filled text', async () => {
    const result = await api.accept(tokens.fresh, { userEULADocId: 999, eulaVersion: '9.9', userEULADocText: 'TAMPERED', userId: prior.userId });

    expect(result.status).toBe(200);
    expect(result.body.data).toBe(true);
    const rows = hostSignedEulas(fresh.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].docId).toBe(tokenized.docId);
    expect(rows[0].version).toBe(tokenized.version);
    expect(rows[0].text).not.toContain('TAMPERED');
    expect(rows[0].text).not.toContain(HOST_NAME_TOKEN);
    expect(rows[0].text).toBe(filledText);
    expect(hostSignedEulas(prior.userId), "the body's userId does not sign for another user").toHaveLength(1);
    expect(await api.hasSignedLatest(tokens.fresh)).toBe(true);
  });

  test('HEULA-04 a user who accepted before the token change is still signed without accepting again', async () => {
    expect(await api.hasSignedLatest(tokens.prior)).toBe(true);
    const rows = hostSignedEulas(prior.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].docId).toBe(original.docId);
    expect(rows[0].text, 'the pre-QC-909 acceptance has no stored text').toBeNull();
  });
});

test.describe('Driver App EULA from the drivers API (QC-909)', { tag: '@write' }, () => {
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
