import { test as setup, expect } from '@playwright/test';
import { ADMIN_STATE, env } from '../config/environment';
import { IdentityLoginPage } from '../pages/IdentityLoginPage';

setup('sign in as the test admin and keep the session', async ({ page }) => {
  setup.skip(!env.admin, 'ADMIN_EMAIL / ADMIN_PASSWORD are not set (see env/example.secrets.env).');

  await page.goto('/');
  await new IdentityLoginPage(page).signIn(env.admin!);

  await expect(page).toHaveURL(`${env.adminUrl}/`);
  await expect(page.locator('#page-heading')).toBeVisible();

  await page.context().storageState({ path: ADMIN_STATE });
});
