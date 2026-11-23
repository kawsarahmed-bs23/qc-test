// QC-986 (replaces the QC-909 host model): the Host keeps no agreement text. auth.UserEULADocs holds one row per version
// and the live row only refers to the website; SignUserEULA returns the live version and its date; Accept stores the live
// doc id and version with no text; the sign-in check passes only for an acceptance of the live version.
// Local only. Host cases (TERMS-*) are API-level against APP_API_URL and run as e2e.qc909.* throwaway host admins seeded
// by seed/identity-qc909-user.apply.sql + seed/host-qc909-user.apply.sql and removed with every acceptance they make.
// They need the QC-986 Version 2 migration (an earlier, no longer live version must exist).
// The Driver App cases (DEULA-*) moved to tests/drivers/driver-terms.spec.ts (DTERMS-*, QC-988).
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { HostAccountApi, identityAccessToken } from '@api/host-account.api';
import {
  HostEulaApi,
  hostSignedEulas,
  liveHostEula,
  liveHostTerms,
  moveAcceptanceToVersion,
  previousHostTerms,
  remainingQc909Rows,
  removeQc909HostUsers,
  seedQc909HostUser,
  type HostTermsVersion,
} from '@api/host-name-eula.api';

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
