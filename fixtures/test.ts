import { test as base, expect } from '@playwright/test';
import { ADMIN_STATE, env } from '../config/environment';
import { AdminShell } from '../pages/AdminShell';

export interface TargetHost {
  uuid: string;
  name: string;
}

type TestFixtures = {
  shell: AdminShell;
};

type WorkerFixtures = {
  targetHost: TargetHost;
};

export const test = base.extend<TestFixtures, WorkerFixtures>({
  shell: async ({ page }, use) => {
    await use(new AdminShell(page));
  },

  targetHost: [
    async ({ browser }, use) => {
      const context = await browser.newContext({
        baseURL: env.adminUrl,
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
        storageState: ADMIN_STATE,
      });
      const page = await context.newPage();
      await page.goto('/hosts');

      const link = page.locator('#hosts-table a.fw-medium', { hasText: env.hostName }).first();
      await expect(link, `Host '${env.hostName}' (HOST_NAME) must be registered in HOST_MASTER`).toBeVisible();

      const href = (await link.getAttribute('href')) ?? '';
      const uuid = href.split('/').filter(Boolean).pop() ?? '';
      expect(uuid, 'host UUID from the hosts list').toMatch(/^[0-9a-f-]{36}$/i);

      await context.close();
      await use({ uuid, name: env.hostName });
    },
    { scope: 'worker' },
  ],
});

export { expect };

export const signedOut = { storageState: { cookies: [], origins: [] } };
