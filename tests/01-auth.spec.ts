import { env } from '../config/environment';
import { test, expect, signedOut } from '../fixtures/test';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';
import { AdminShell } from '../pages/AdminShell';

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
      const response = await page.goto('/permission-denied');
      expect(response?.status()).toBe(200);
      await expect(page.locator('#page-heading')).toHaveText('Permission denied');
    });

    test('AUTH-04 an admin signs in and lands on the dashboard', { tag: '@smoke' }, async ({ page }) => {
      test.skip(!env.admin, 'No admin credentials');
      await page.goto('/');
      await new IdentityLoginPage(page).signIn(env.admin!);
      await expect(page).toHaveURL(`${env.adminUrl}/`);
      await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
    });

    test('AUTH-05 a user without the Admin role sees Permission denied, also on deep links', async ({ page }) => {
      test.skip(!env.driver, 'No DRIVER_EMAIL / DRIVER_PASSWORD');
      await page.goto('/hosts');
      await new IdentityLoginPage(page).signIn(env.driver!);
      await expect(page).toHaveURL(/\/permission-denied/);
      await expect(page.locator('#page-heading')).toHaveText('Permission denied');

      await page.goto('/');
      await expect(page).toHaveURL(/\/permission-denied/);

      await page.locator('#sign-out').click();
      await new IdentityLoginPage(page).expectVisible();
    });

    test('AUTH-06 signing out ends the session; the dashboard needs a new sign-in', { tag: '@smoke' }, async ({ page }) => {
      test.skip(!env.admin, 'No admin credentials');
      await page.goto('/');
      await new IdentityLoginPage(page).signIn(env.admin!);
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

  test('AUTH-08 Identity sends a signed-in admin straight to the Admin site', async ({ page }) => {
    await page.goto(`${env.identityUrl}/`);
    await expect(page).toHaveURL(`${env.adminUrl}/`);
    await expect(page.getByRole('heading', { name: /welcome back/i })).toBeVisible();
  });
});
