import { test as base, expect } from '@playwright/test';
import { ADMIN_STATE, env } from '../config/environment';
import { AdminShell, adminUrl } from '../pages/AdminShell';

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
      await page.goto(adminUrl('/hosts'));

      const row = page.locator('#hosts-table tr[data-host-uuid]').filter({ has: page.locator('[data-testid="host-link"]', { hasText: env.hostName }) }).first();
      await expect(row, `Host '${env.hostName}' (HOST_NAME) must be registered in HOST_MASTER`).toBeVisible();

      const uuid = ((await row.getAttribute('data-host-uuid')) ?? '').toLowerCase();
      expect(uuid, 'host UUID from the hosts list').toMatch(/^[0-9a-f-]{36}$/i);

      await context.close();
      await use({ uuid, name: env.hostName });
    },
    { scope: 'worker' },
  ],
});

export { expect };

export const signedOut = { storageState: { cookies: [], origins: [] } };
