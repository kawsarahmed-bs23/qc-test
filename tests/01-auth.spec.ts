import { env, type Credentials } from '../config/environment';
import { test, expect, signedOut } from '../fixtures/test';
import { adminAccount, adminAuthenticatorKey, canSeedThrowawayUsers, removeIdentityUsers, seedIdentityUser } from '../fixtures/throwawayUsers';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';
import { AdminShell, adminUrl } from '../pages/AdminShell';

const NOT_AN_ADMIN = 'e2e.qc775.t.auth05@quarryconnect.test';

async function signInAsAdmin(login: IdentityLoginPage, admin: Credentials): Promise<void> {
  const key = adminAuthenticatorKey();
  await (key ? login.signInWithTwoStep(admin, key) : login.signIn(admin));
}

test.describe('Sign-in and access control', () => {
  test.describe('signed out', () => {
    test.use(signedOut);

    test('AUTH-01 visiting the Admin site signed out redirects to the Identity sign-in page', { tag: '@smoke' }, async ({ page }) => {
      await page.goto('/');
      await new IdentityLoginPage(page).expectVisible();
    });

    test('AUTH-02 every Admin page is protected, not only the dashboard', async ({ page }) => {
      for (const path of ['/hosts', '/hosts/new', '/activity']) {
        await page.goto(path);
        await new IdentityLoginPage(page).expectVisible();
      }
    });

    test('AUTH-03 the permission-denied page is reachable without signing in', async ({ page }) => {
      const response = await page.goto(adminUrl('/permission-denied'));
      expect(response?.status()).toBe(200);
      await expect(page.locator('#page-heading')).toHaveText('Permission denied');
      await expect(page.locator('#permission-denied-sign-in')).toBeVisible();
    });

    test('AUTH-04 an admin signs in with two-step verification and lands on the dashboard', { tag: '@smoke' }, async ({ page }) => {
      const admin = adminAccount();
      test.skip(!admin, 'No admin credentials');
      await page.goto('/');
      await signInAsAdmin(new IdentityLoginPage(page), admin!);
      await expect(page).toHaveURL(new RegExp(`^${env.adminUrl}/`));
      await expect(page.locator('#dashboard-welcome')).toContainText('Welcome back');
    });

    test('AUTH-05 a signed-in account that is not a platform admin sees Permission denied, also on deep links', { tag: '@write' }, async ({ page }) => {
      test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database for a throwaway account with two-step verification.");
      const user = seedIdentityUser(NOT_AN_ADMIN, 'QC-775 Not an admin', true);

      try {
        await page.goto('/hosts');
        await new IdentityLoginPage(page).signInWithTwoStep(user, user.authenticatorKey!);
        await expect(page).toHaveURL(/\/permission-denied/);
        await expect(page.locator('#page-heading')).toHaveText('Permission denied');

        await page.goto('/');
        await expect(page).toHaveURL(/\/permission-denied/);

        await page.locator('#permission-denied-sign-out').click();
        await new IdentityLoginPage(page).expectVisible();
      } finally {
        removeIdentityUsers(NOT_AN_ADMIN);
      }
    });

    test('AUTH-06 signing out ends the session; the dashboard needs a new sign-in', { tag: '@smoke' }, async ({ page }) => {
      const admin = adminAccount();
      test.skip(!admin, 'No admin credentials');
      await page.goto('/');
      await signInAsAdmin(new IdentityLoginPage(page), admin!);
      await expect(page).toHaveURL(`${env.adminUrl}/`);

      await new AdminShell(page).signOut();
      await new IdentityLoginPage(page).expectVisible();

      await page.goto('/');
      await new IdentityLoginPage(page).expectVisible();
    });

    test('AUTH-07 the old Identity admin panel is gone', async ({ request }) => {
      for (const path of ['/Admin', '/Admin/Hosts/Index', '/qc-ui/admin.css']) {
        const response = await request.get(`${env.identityUrl}${path}`, { maxRedirects: 0, ignoreHTTPSErrors: env.ignoreHttpsErrors });
        expect(response.status(), path).toBe(404);
      }
    });
  });

  test("AUTH-08 Identity's root sends even a signed-in admin to the public site, not to Admin (QC-775)", async ({ page }) => {
    const response = await page.request.get(`${env.identityUrl}/`, { maxRedirects: 0 });
    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe(env.landingUrl ?? 'https://www.quarryconnect.com/');
  });
});
