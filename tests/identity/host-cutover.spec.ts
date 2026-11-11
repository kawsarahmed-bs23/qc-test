import type { Browser, BrowserContext } from '@playwright/test';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { activeHostSessions, HostAppTab, identitySessions, qc616UsersLeft, removeQc616Users, revokeHostSession, seedQc616User } from '@pages/host-cutover.page';

async function appIsUp(): Promise<boolean> {
  if (!env.appUrl) return false;
  return fetch(env.appUrl)
    .then((r) => r.ok)
    .catch(() => false);
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
}

async function signOutIfInApp(tab: HostAppTab): Promise<void> {
  if (await tab.isInApp().catch(() => false)) {
    await tab.signOut();
    await tab.expectOnIdentityLogin(30_000);
  }
}

const canRun = (): boolean => !!env.appAdmin && !!env.appApiUrl && canUseIdentityDb() && canSeedLocalDb();

test.describe('Host cutover to IdentityServer (QC-616)', { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);

  let user: ThrowawayUser;

  test.beforeAll(() => {
    if (!canRun()) return;
    removeQc616Users();
    user = seedQc616User();
  });

  test.afterAll(() => {
    if (!canRun()) return;
    removeQc616Users();
    expect(qc616UsersLeft(), 'no e2e.qc616.* user left in Identity').toBe(0);
  });

  test.beforeEach(async () => {
    test.skip(!env.appAdmin, 'APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD are not set (config/.env.<env>.app.secrets).');
    test.skip(!env.appApiUrl, 'APP_API_URL is not set.');
    test.skip(!canUseIdentityDb() || !canSeedLocalDb(), 'The cases seed the Identity and host databases (local only).');
    test.skip(!(await appIsUp()), `The host app is not running on ${env.appUrl}.`);
  });

  test('CUT-01 a host password copied into Identity keeps its hash and signs in through Identity to the host app', async ({ browser }) => {
    const hostDb = env.localSql!.database;
    expect(identitySessions.hostPasswordHashMatches(env.appAdmin!.email, hostDb), 'APP_ADMIN Identity PasswordHash equals its host hash (same UserUUID)').toBe(
      true,
    );
    expect(identitySessions.hostPasswordHashMatches(user.email, hostDb), 'the copied user has the host hash in Identity').toBe(true);

    const context = await newContext(browser);
    const tab = await HostAppTab.open(context);
    try {
      await tab.signIn(user, user.authenticatorKey);
      await tab.expectSignedIn();
    } finally {
      await signOutIfInApp(tab).catch(() => undefined);
      await context.close();
    }
  });

  test('CUT-02 signing out in one tab sends the other tab of the same host to Identity login with no click or reload', async ({ browser }, testInfo) => {
    const context = await newContext(browser);
    const tabA = await HostAppTab.open(context);
    try {
      await tabA.signIn(user, user.authenticatorKey);
      const tabB = await HostAppTab.open(context);
      await tabB.openSignedIn();

      const signedOutAt = Date.now();
      await tabA.signOut();
      const landedAt = await tabB.expectOnIdentityLogin(15_000);

      testInfo.annotations.push({ type: 'other tab ended after (ms)', description: String(landedAt - signedOutAt) });
      expect(landedAt - signedOutAt, 'tab B reaches Identity login within 10 s').toBeLessThan(10_000);
      expect(await tabB.appAccessToken(), 'no host accessToken left in the shared storage').toBeNull();
    } finally {
      await context.close();
    }
  });

  test(
    'CUT-03 an Identity session that times out in the sweeper ends the open host tab by push, with no user action',
    { tag: ['@write'] },
    async ({ browser }, testInfo) => {
      test.setTimeout(240_000);
      const subject = identitySessions.subjectFor(user.email);
      const mark = identitySessions.lastId();

      const context = await newContext(browser);
      const tab = await HostAppTab.open(context);
      let changedIds: number[] = [];
      try {
        await tab.signIn(user, user.authenticatorKey);
        await tab.expectSessionHubConnected();
        expect(await tab.appAccessToken(), 'host accessToken after sign-in').not.toBeNull();

        const original = identitySessions.openSince(subject, mark);
        expect(original.length, 'the open Identity session this sign-in created').toBeGreaterThan(0);
        testInfo.annotations.push({ type: 'original sessions', description: JSON.stringify(original) });
        changedIds = original.map((row) => row.id);

        const updatedAt = Date.now();
        expect(identitySessions.expireIdle(subject, changedIds), 'rows changed by the IdleExpires UPDATE').toBe(changedIds.length);

        const landedAt = await tab.expectOnIdentityLogin(120_000);
        testInfo.annotations.push({ type: 'push: UPDATE to Identity login (ms)', description: String(landedAt - updatedAt) });
        expect(tab.firstAt('recheck', undefined, updatedAt), 'no focus re-check ran, so the push ended the tab').toBeUndefined();
        expect(await tab.appAccessToken(), 'host accessToken removed').toBeNull();
      } finally {
        await context.close();
        if (changedIds.length) {
          const after = identitySessions.rows(`UserSessionID IN (${changedIds.join(',')})`);
          testInfo.annotations.push({ type: 'sessions after', description: JSON.stringify(after) });
          testInfo.annotations.push({ type: 'active host sessions after', description: String(activeHostSessions(user.userId)) });
          expect(
            after.every((row) => row.ended !== null),
            'every session the case changed is ended',
          ).toBe(true);
        }
      }
    },
  );

  test('CUT-04 a host session revoked on the server ends the tab when it comes back into focus', { tag: ['@write'] }, async ({ browser }, testInfo) => {
    test.setTimeout(150_000);
    const context = await newContext(browser);
    const tab = await HostAppTab.open(context);
    try {
      await tab.signIn(user, user.authenticatorKey);
      await tab.expectSessionHubConnected();
      const token = (await tab.appAccessToken())!;

      const revokedAt = Date.now();
      expect(await revokeHostSession(token, await tab.userAgent()), 'POST /api/account/logout with the tab token').toBe(200);

      await expect
        .poll(
          async () => {
            await tab.focus();
            return tab.leftForIdentityAt(revokedAt) ?? null;
          },
          { message: 'the tab restarts sign-in at Identity after focus', timeout: 60_000, intervals: [2_000] },
        )
        .not.toBeNull();

      const leftAt = tab.leftForIdentityAt(revokedAt)!;
      const recheckAt = tab.firstAt('recheck', undefined, revokedAt);
      const path = recheckAt !== undefined && recheckAt <= leftAt ? 'focus re-check' : 'push';
      testInfo.annotations.push({ type: 'ended by', description: `${path} after ${leftAt - revokedAt} ms` });
      expect(await tab.appAccessToken(), 'the revoked accessToken is gone').not.toBe(token);
      testInfo.annotations.push({ type: 'landed on', description: tab.tab.url().split('?')[0] });
    } finally {
      await signOutIfInApp(tab).catch(() => undefined);
      await context.close();
    }
  });
});
