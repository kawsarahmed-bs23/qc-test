import { test as setup, expect } from '@playwright/test';
import { APP_STATE, env } from '../../config/environment';
import { AppSignInPage } from '../../pages/AppPages';

setup('sign in to the host app as the test admin and keep the session', async ({ page }) => {
  setup.skip(!env.appUrl, 'APP_URL is not set for this environment.');
  setup.skip(!env.appAdmin, 'APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD are not set (see env/<env>.app.secrets.env).');

  const signIn = new AppSignInPage(page);
  await signIn.open();
  await signIn.signIn(env.appAdmin!);

  await expect(page).not.toHaveURL(/#\/authentication/);

  await page.context().storageState({ path: APP_STATE });
});
