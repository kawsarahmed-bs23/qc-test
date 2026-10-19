import { test as setup, expect } from '@playwright/test';
import { ADMIN_STATE, env } from '../config/environment';
import { accessTokenFromPage } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';

setup('sign in as the test admin through the Admin app and keep the session', async ({ page }) => {
  setup.skip(!env.admin, 'ADMIN_EMAIL / ADMIN_PASSWORD are not set (see env/example.secrets.env).');

  await page.goto(adminUrl('/'));
  await new IdentityLoginPage(page).signIn(env.admin!);

  await expect(page).toHaveURL(adminUrl('/'));
  await expect(page.locator('#page-heading')).toHaveText('Dashboard');
  await expect(page.locator('#kpis')).toBeVisible();
  expect(await accessTokenFromPage(page), 'the Admin app keeps its access token in localStorage').toBeTruthy();

  await page.context().storageState({ path: ADMIN_STATE });
});
