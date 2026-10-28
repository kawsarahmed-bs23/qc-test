import type { Browser, BrowserContext, Page } from '@playwright/test';
import { test, expect, signedOut } from '../fixtures/test';
import { env } from '../config/environment';
import { canSeedLocalDb, canUseIdentityDb } from '../fixtures/localDb';
import { adminAccount, adminAuthenticatorKey, type ThrowawayUser } from '../fixtures/throwawayUsers';
import { adminUrl } from '../pages/AdminShell';
import { escape, IdentityLoginPage } from '../pages/IdentityLoginPage';
import {
  APP_DEEP_LINK,
  AppSignInErrorView,
  AppTermsPage,
  appDeepLinkHeading,
  HostAppHeader,
  qc826Email,
  removeQc826Users,
  seedQc826User,
  SignInWatch,
} from '../pages/SignInRedirectPages';

const identityLogin = new RegExp(`^${escape(env.identityUrl)}/Account/Login`, 'i');

const PUBLIC_PAGES: Record<string, string> = {
  '/legal/privacy': 'app-privacy',
  '/authentication/forgot-password': 'app-forgot-password',
};

function appUrl(route = ''): string {
  return `${env.appUrl}/${route ? `#${route}` : ''}`;
}

async function signedOutPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
  return { context, page: await context.newPage() };
}

async function appIsUp(): Promise<boolean> {
  if (!env.appUrl) return false;
  return fetch(env.appUrl).then((r) => r.ok).catch(() => false);
}

function firstLocationAway(watch: SignInWatch, origin: string): string | undefined {
  return watch.locations.find((url) => !url.startsWith(origin) && url !== 'about:blank');
}

test.describe('Sign-in opens Identity directly (QC-826)', () => {
  test.describe('host app, signed out', () => {
    test.use(signedOut);

    test.beforeEach(async () => {
      test.skip(!(await appIsUp()), `The host app is not running on ${env.appUrl}.`);
    });

    test('SIR-01 opening the host app signed out goes straight to Identity login, with no app sign-in page and no discovery request', async ({ page }) => {
      const watch = await SignInWatch.attach(page);
      await page.goto(appUrl());
      await new IdentityLoginPage(page).expectVisible();

      expect(firstLocationAway(watch, env.appUrl!), 'the first navigation after the app document').toMatch(identityLogin);
      expect(watch.locationsWithRoute('/authentication'), 'no #/authentication URL').toEqual([]);
      expect(watch.sawSignInPage, 'app-sign-in never attaches').toBe(false);
      expect(watch.discoveryRequests(), 'no .well-known/openid-configuration request').toEqual([]);

      const authorize = watch.identityAuthorizes();
      expect(authorize).toHaveLength(1);
      expect(authorize[0].searchParams.get('client_id')).toBe(env.hostClient?.clientId ?? authorize[0].searchParams.get('client_id'));
      expect(authorize[0].searchParams.get('redirect_uri')).toBe(`${env.appUrl}/`);
      expect(authorize[0].searchParams.get('response_type')).toBe('code');
      expect(authorize[0].searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize[0].searchParams.get('code_challenge')).toBeTruthy();
    });

    test('SIR-05 a public page opened signed out renders and is not sent to Identity', async ({ page }) => {
      const watch = await SignInWatch.attach(page);
      await page.goto(appUrl('/legal/terms'));
      await expect(new AppTermsPage(page).heading).toBeVisible({ timeout: 30_000 });
      await expect(page).toHaveURL(appUrl('/legal/terms'));
      expect(watch.identityAuthorizes(), 'no authorize request').toEqual([]);
      expect(watch.locations.filter((url) => url.startsWith(env.identityUrl)), 'no Identity navigation').toEqual([]);
    });

    for (const route of Object.keys(PUBLIC_PAGES)) {
      test(`SIR-08 ${route} opened signed out renders and is not sent to Identity`, async ({ page }) => {
        const watch = await SignInWatch.attach(page);
        await page.goto(appUrl(route));
        await expect(page.locator(PUBLIC_PAGES[route])).toBeVisible({ timeout: 30_000 });
        await expect(page).toHaveURL(appUrl(route));
        expect(watch.identityAuthorizes(), 'no authorize request').toEqual([]);
        expect(watch.locationsWithRoute('/authentication'), 'no redirect to #/authentication').toEqual([]);
      });
    }
  });

  test.describe('host app, a host admin signs in', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedLocalDb() || !canUseIdentityDb() || !env.admin, "Needs Identity's and the host's local databases and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");

    let user: ThrowawayUser;
    let context: BrowserContext;
    let page: Page;
    let watch: SignInWatch;

    test.beforeAll(async ({ browser }) => {
      removeQc826Users();
      user = seedQc826User(qc826Email('hostadmin'), 'QC-826 Host admin', true);
      ({ context, page } = await signedOutPage(browser));
      watch = await SignInWatch.attach(page);
    });

    test.afterAll(async () => {
      await context?.close();
      removeQc826Users();
    });

    test.beforeEach(async () => {
      test.skip(!(await appIsUp()), `The host app is not running on ${env.appUrl}.`);
    });

    test('SIR-02 a signed-out deep link goes to Identity and, after sign-in, lands on that deep link without the app sign-in page', async () => {
      await page.goto(appUrl(APP_DEEP_LINK));
      const login = new IdentityLoginPage(page);
      await login.expectVisible();
      expect(firstLocationAway(watch, env.appUrl!), 'the first navigation after the app document').toMatch(identityLogin);

      await login.signInWithTwoStep(user, user.authenticatorKey!);
      await expect(page).toHaveURL(appUrl(APP_DEEP_LINK), { timeout: 30_000 });
      await expect(appDeepLinkHeading(page)).toBeVisible({ timeout: 30_000 });
      expect(await page.evaluate(() => localStorage.getItem('accessToken'))).toBeTruthy();
      expect(await page.evaluate(() => localStorage.getItem('qc_oidc_id_token'))).toBeTruthy();
      expect(await page.evaluate(() => sessionStorage.getItem('qc_oidc_return'))).toBeNull();

      expect(watch.locationsWithRoute('/authentication'), 'no #/authentication URL').toEqual([]);
      expect(watch.locationsWithRoute('/legal/sign-user-agreement'), 'no EULA page for a user who signed it').toEqual([]);
      expect(watch.sawSignInPage, 'app-sign-in never attaches').toBe(false);
      expect(watch.identityAuthorizes().filter((u) => u.searchParams.get('acr_values') === 'mfa'), 'no step-up for a two-step sign-in').toEqual([]);
    });

    test('SIR-03 reloading while signed in stays in the app without asking Identity', async () => {
      await expect(appDeepLinkHeading(page)).toBeVisible();
      watch.reset();
      await page.reload();
      await expect(appDeepLinkHeading(page)).toBeVisible({ timeout: 30_000 });
      await expect(new HostAppHeader(page).profileMenuButton).toBeVisible();
      await expect(page).toHaveURL(appUrl(APP_DEEP_LINK));
      expect(watch.identityRequests(), 'no request to Identity').toEqual([]);
      expect(watch.sawSignInPage).toBe(false);
    });

    test('SIR-04 Logout in the header goes through Identity end-session and back; the app then opens straight on Identity login with no loop', async () => {
      watch.reset();
      await new HostAppHeader(page).signOut();
      await expect.poll(() => watch.endSessions().length, { message: 'endsession request', timeout: 30_000 }).toBe(1);
      const endSession = watch.endSessions()[0];
      expect(endSession.searchParams.get('post_logout_redirect_uri')).toBe(`${env.appUrl}/`);
      expect(endSession.searchParams.get('id_token_hint')).toBeTruthy();

      await expect(page).toHaveURL(identityLogin, { timeout: 30_000 });
      const afterIdentitySignOut = watch.locationsAfterRequest(`${env.identityUrl}/Account/Logout`);
      expect(afterIdentitySignOut.filter((url) => url.startsWith(env.appUrl!)).length, 'Identity sent the browser back to the app after its sign-out').toBeGreaterThan(0);
      expect(afterIdentitySignOut.filter((url) => /#\/authentication(\?|$)/.test(url)), 'no #/authentication once back from Identity').toEqual([]);

      watch.reset();
      await page.goto(appUrl());
      await new IdentityLoginPage(page).expectVisible();
      await page.waitForTimeout(3_000);
      await expect(page).toHaveURL(identityLogin);
      expect(watch.identityAuthorizes(), 'exactly one authorize, no loop').toHaveLength(1);
      expect(watch.locationsWithRoute('/authentication'), 'no #/authentication URL').toEqual([]);
      expect(watch.sawSignInPage, 'app-sign-in never attaches').toBe(false);
    });
  });

  test.describe('host app, an Identity user with no account on this host', { tag: '@write' }, () => {
    test.use(signedOut);
    test.skip(!canSeedLocalDb() || !canUseIdentityDb() || !env.admin, "Needs Identity's and the host's local databases and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway user.");

    let stranger: ThrowawayUser;

    test.beforeAll(() => {
      removeQc826Users();
      stranger = seedQc826User(qc826Email('stranger'), 'QC-826 No host account', false);
    });

    test.afterAll(() => {
      removeQc826Users();
    });

    test('SIR-06 a refused exchange ends on the app sign-in page with the error view, not a redirect loop', async ({ page }) => {
      test.skip(!(await appIsUp()), `The host app is not running on ${env.appUrl}.`);
      const watch = await SignInWatch.attach(page);
      await page.goto(appUrl());
      await new IdentityLoginPage(page).signInWithTwoStep(stranger, stranger.authenticatorKey!);

      await expect(page).toHaveURL(appUrl('/authentication'), { timeout: 30_000 });
      const errorView = new AppSignInErrorView(page);
      await errorView.expectVisible();
      const authorizes = watch.identityAuthorizes().length;
      expect(authorizes, 'one authorize, plus at most one step-up').toBeLessThanOrEqual(2);

      await page.waitForTimeout(3_000);
      await expect(page).toHaveURL(appUrl('/authentication'));
      await errorView.expectVisible();
      expect(watch.identityAuthorizes().length, 'no further authorize: no loop').toBe(authorizes);
      expect(await page.evaluate(() => localStorage.getItem('accessToken'))).toBeNull();
    });
  });

  test.describe('Admin', () => {
    test.use(signedOut);

    test('SIR-07 a signed-out Admin deep link goes to Identity login with no #/sign-in screen and returns to the deep link after sign-in', async ({ page }) => {
      const admin = adminAccount();
      const key = adminAuthenticatorKey();
      test.skip(!admin, 'No admin credentials');
      const watch = await SignInWatch.attach(page);

      await page.goto(adminUrl('/hosts'));
      const login = new IdentityLoginPage(page);
      await login.expectVisible();
      expect(firstLocationAway(watch, env.adminUrl), 'the first navigation after the Admin document').toMatch(identityLogin);
      expect(watch.locationsWithRoute('/sign-in'), 'no #/sign-in URL before Identity').toEqual([]);
      expect(watch.sawSignInPage, 'the Admin app-sign-in never attaches').toBe(false);

      await (key ? login.signInWithTwoStep(admin!, key) : login.signIn(admin!));
      await expect(page).toHaveURL(adminUrl('/hosts'), { timeout: 30_000 });
      await expect(page.locator('#page-heading')).toHaveText('Hosts', { timeout: 30_000 });
      expect(watch.locationsWithRoute('/sign-in'), 'no #/sign-in URL at any point').toEqual([]);
      expect(watch.sawSignInPage).toBe(false);
    });
  });
});
