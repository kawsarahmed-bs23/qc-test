import { test as setup, expect } from '@playwright/test';
import { ADMIN_STATE } from '../config/environment';
import { adminAccount, adminAuthenticatorKey } from '../fixtures/throwawayUsers';
import { accessTokenFromPage } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';

setup('sign in as the test admin through the Admin app and keep the session', async ({ page }) => {
  const admin = adminAccount();
  const authenticatorKey = adminAuthenticatorKey();
  setup.skip(!admin, 'ADMIN_EMAIL / ADMIN_PASSWORD are not set (see env/example.secrets.env).');
  setup.setTimeout(150_000);

  await page.goto(adminUrl('/'));
  const login = new IdentityLoginPage(page);
  if (authenticatorKey) {
    await login.signInWithTwoStep(admin!, authenticatorKey);
  } else {
    await login.signIn(admin!);
  }

  const heading = page.locator('#page-heading');
  await expect(heading).toHaveText(/^(Dashboard|Permission denied)$/, { timeout: 30_000 });
  await expect
    .poll(
      async () => {
        if ((await heading.innerText()).trim() !== 'Dashboard') {
          await page.goto(adminUrl('/'));
          await page.reload();
          await expect(heading).toHaveText(/^(Dashboard|Permission denied)$/, { timeout: 30_000 });
        }
        return (await heading.innerText()).trim();
      },
      { message: 'the Admin API counts the platform admin (its admin list is cached for a minute)', timeout: 100_000, intervals: [5_000, 10_000] },
    )
    .toBe('Dashboard');
  await expect(page.locator('#kpis')).toBeVisible();
  expect(await accessTokenFromPage(page), 'the Admin app keeps its access token in localStorage').toBeTruthy();

  await page.context().storageState({ path: ADMIN_STATE });
});
