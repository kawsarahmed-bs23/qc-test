import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb } from '@utils/localDb';
import { removeQc993Users, seedQc993User } from '@pages/session-idle.page';
import type { Credentials } from '@config/env.config';

const JOB_ADD = '/#/jobs/job-add';
const NON_ACCOUNT_API = /\/api\/(?!account\/)/;

test.describe('Idle warning, session lock and silent refresh (QC-993)', { tag: ['@write', '@regression'] }, () => {
  test.use(signedOut);
  test.skip(
    !canSeedLocalDb() || !env.appAdmin || !env.appApiUrl,
    'Needs the local host database, APP_ADMIN_* (the throwaway user copies its password) and APP_API_URL.',
  );

  let user: Credentials;

  test.beforeAll(() => {
    removeQc993Users();
    user = seedQc993User();
  });

  test.afterAll(() => {
    removeQc993Users();
  });

  test('IDLE-01 near the timeout a warning opens and Stay signed in keeps the session and resets the timer', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    idleWarningDialog,
    lockScreen,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    const timeout = await sessionStorageProbe.idleTimeoutMs();
    const stamped = await sessionStorageProbe.setLastActivityAgo(timeout - 59_000);

    await idleWarningDialog.expectOpen();
    await idleWarningDialog.stay.click();

    await expect(idleWarningDialog.dialog).toHaveCount(0);
    await expect.poll(() => sessionStorageProbe.lastActivity()).toBeGreaterThan(stamped + 30_000);
    await lockScreen.expectUnlocked();
    expect(await sessionStorageProbe.accessToken()).toBeTruthy();
  });

  test('IDLE-02 at the timeout the host session is revoked and the same page is covered by the lock overlay', async ({
    appPasswordSignInPage,
    jobDraftPage,
    sessionStorageProbe,
    lockScreen,
    sessionTraffic,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    sessionTraffic.forgetRoutesSoFar();
    await jobDraftPage.open();
    await jobDraftPage.expectFormReady();
    const route = page.url();
    const logout = page.waitForRequest((request) => request.url().endsWith('/api/account/logout'));
    await sessionStorageProbe.setLastActivityAgo((await sessionStorageProbe.idleTimeoutMs()) + 1_000);

    await lockScreen.expectLocked(user.email);
    await logout;
    await expect(lockScreen.message).toContainText('Your session ended after');
    expect(page.url()).toBe(route);
    expect(await sessionStorageProbe.accessToken()).toBeNull();
    expect(sessionTraffic.signedOutRoutes()).toEqual([]);
    await expect(jobDraftPage.customerPo).toBeVisible();
  });

  test('IDLE-03 signing in with the password on the overlay closes it and keeps the route and the typed form value', async ({
    appPasswordSignInPage,
    jobDraftPage,
    sessionStorageProbe,
    lockScreen,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    await jobDraftPage.open();
    await jobDraftPage.expectFormReady();
    const route = page.url();
    await jobDraftPage.typeCustomerPo('E2E-QC993-PO');
    await sessionStorageProbe.setLastActivityAgo((await sessionStorageProbe.idleTimeoutMs()) + 1_000);

    await lockScreen.expectLocked(user.email);
    await lockScreen.unlockWithPassword(user.password);

    await lockScreen.expectUnlocked();
    expect(page.url()).toBe(route);
    await expect(jobDraftPage.customerPo).toHaveValue('E2E-QC993-PO');
    expect(await sessionStorageProbe.accessToken()).toBeTruthy();
  });

  test('IDLE-04 a wrong password on the overlay shows an error and keeps the page locked', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    lockScreen,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    await sessionStorageProbe.setLastActivityAgo((await sessionStorageProbe.idleTimeoutMs()) + 1_000);

    await lockScreen.expectLocked(user.email);
    await lockScreen.unlockWithPassword('Not-The-Password-1!');

    await expect(lockScreen.error).toBeVisible();
    await expect(lockScreen.title).toBeVisible();
  });

  test('IDLE-05 activity before the warning resets the idle timer', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    idleWarningDialog,
    lockScreen,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    const timeout = await sessionStorageProbe.idleTimeoutMs();
    const stamped = await sessionStorageProbe.setLastActivityAgo(timeout - 90_000);

    await expect
      .poll(async () => {
        await page.keyboard.press('Shift');
        return sessionStorageProbe.lastActivity();
      })
      .toBeGreaterThan(stamped + 20_000);

    await expect(idleWarningDialog.dialog).toHaveCount(0);
    await lockScreen.expectUnlocked();
  });

  test('IDLE-06 an active user stays signed in across silent refreshes of the 60 second access token', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    sessionTraffic,
    lockScreen,
    page,
  }) => {
    test.setTimeout(240_000);
    await appPasswordSignInPage.signInAndWaitForApp(user);
    sessionTraffic.forgetRoutesSoFar();
    expect(await sessionStorageProbe.accessTokenLifetimeSeconds(), 'the local host issues 60 second access tokens').toBeLessThanOrEqual(60);
    const first = await sessionStorageProbe.accessToken();
    const routes = ['/#/jobs', '/#/dashboard/main'];
    let visits = 0;

    await expect
      .poll(
        async () => {
          await sessionStorageProbe.setLastActivityAgo(0);
          await page.goto(routes[visits++ % routes.length]);
          return sessionTraffic.refreshStatuses.length;
        },
        { timeout: 200_000, intervals: [4_000] },
      )
      .toBeGreaterThanOrEqual(2);

    expect(sessionTraffic.refreshStatuses.every((status) => status === 200)).toBe(true);
    expect(await sessionStorageProbe.accessToken()).not.toBe(first);
    await lockScreen.expectUnlocked();
    expect(sessionTraffic.signedOutRoutes()).toEqual([]);
  });

  test('IDLE-07 a 401 on a request makes one refresh and a retry, with no lock and no sign-out', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    sessionTraffic,
    lockScreen,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    sessionTraffic.forgetRoutesSoFar();
    const before = sessionTraffic.refreshStatuses.length;
    const refused = await sessionTraffic.answerNextApiCall(401, NON_ACCOUNT_API);

    await page.goto('/#/jobs');

    await expect.poll(() => sessionTraffic.refreshStatuses.slice(before)).toEqual([200]);
    expect(refused.hits()).toBeGreaterThan(1);
    await lockScreen.expectUnlocked();
    expect(await sessionStorageProbe.accessToken()).toBeTruthy();
    expect(sessionTraffic.signedOutRoutes()).toEqual([]);
  });

  test('IDLE-08 a 409 from the refresh is not fatal: the request is retried and the page stays signed in', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    sessionTraffic,
    lockScreen,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    sessionTraffic.forgetRoutesSoFar();
    const before = sessionTraffic.refreshStatuses.length;
    const conflicted = await sessionTraffic.answerNextRefresh(409);
    const refused = await sessionTraffic.answerNextApiCall(401, NON_ACCOUNT_API);

    await page.goto('/#/jobs');

    await expect.poll(() => conflicted.hits()).toBe(1);
    await expect.poll(() => refused.hits()).toBeGreaterThanOrEqual(2);
    expect(sessionTraffic.refreshStatuses.slice(before)).toEqual([409]);
    await lockScreen.expectUnlocked();
    expect(await sessionStorageProbe.accessToken()).toBeTruthy();
    expect(sessionTraffic.signedOutRoutes()).toEqual([]);
  });

  test('IDLE-09 a refresh that fails locks the page on the route it reached instead of signing out and navigating', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    sessionTraffic,
    lockScreen,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    sessionTraffic.forgetRoutesSoFar();
    await sessionStorageProbe.setRefreshToken('revoked-refresh-token');
    await sessionTraffic.answerNextApiCall(401, NON_ACCOUNT_API);

    await page.goto('/#/jobs');

    await lockScreen.expectLocked(user.email);
    await expect(page).toHaveURL(/#\/jobs$/);
    expect(await sessionStorageProbe.accessToken()).toBeNull();
    expect(sessionTraffic.signedOutRoutes()).toEqual([]);
  });

  test('IDLE-10 a session that ended on a page returns to that page after the password sign-in, not the dashboard', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    page,
  }) => {
    await appPasswordSignInPage.open();
    await sessionStorageProbe.setReturnRoute('/jobs/job-add');

    await appPasswordSignInPage.signIn(user);

    await expect(page).toHaveURL(/#\/jobs\/job-add$/, { timeout: 30_000 });
    expect(await sessionStorageProbe.returnRoute()).toBeNull();
  });

  test('IDLE-11 with no stored route the password sign-in lands on the dashboard', async ({ appPasswordSignInPage, page }) => {
    await appPasswordSignInPage.open();

    await appPasswordSignInPage.signIn(user);

    await expect(page).toHaveURL(/#\/dashboard\//, { timeout: 30_000 });
  });

  test('IDLE-12 a page that is open when its login token is revoked is kept as the return route for the sign-in page', async ({
    appPasswordSignInPage,
    sessionStorageProbe,
    page,
  }) => {
    await appPasswordSignInPage.signInAndWaitForApp(user);
    await page.goto(JOB_ADD);
    await page.evaluate(() => {
      localStorage.setItem('refreshTokenExpiredAt', new Date(Date.now() - 60_000).toISOString());
    });

    await page.reload();

    await expect(appPasswordSignInPage.email).toBeVisible({ timeout: 30_000 });
    expect(await sessionStorageProbe.returnRoute()).toBe('/jobs/job-add');
  });
});
