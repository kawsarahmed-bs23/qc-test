// QC-983: Admin Test connection also asks the running host whether it can send invites. Read-only: Test connection only calls
// the host API with Admin's service token. The local host may or may not have its invite settings, so the cases accept ready or
// not-ready and check that the answer, the line under the connection result and the host's own readiness endpoint agree.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { AdminApi } from '@api/admin.api';

const STATUSES = ['ready', 'not-ready', 'not-used', 'unknown'];

test.describe('Admin Test connection shows invite readiness (QC-983)', { tag: ['@regression'] }, () => {
  test('HINV-01 Test connection on a host returns message, inviteStatus and inviteMissing', async ({ request, targetHost }) => {
    const tested = await AdminApi.asAdmin(request).post(`/hosts/${targetHost.uuid}/test-connection`);
    expect(tested.status, tested.text).toBe(200);
    expect(tested.body.message).toEqual(expect.any(String));
    expect(STATUSES).toContain(tested.body.inviteStatus);
    expect(Array.isArray(tested.body.inviteMissing)).toBe(true);
    if (tested.body.inviteStatus === 'not-ready') {
      expect(tested.body.inviteMissing.length, 'not-ready names what is missing').toBeGreaterThan(0);
    } else {
      expect(tested.body.inviteMissing).toEqual([]);
    }
  });

  test('HINV-02 the Host detail page shows the invites line under the connection result after Test connection', async ({ hostInviteLinePage: host, targetHost, request }) => {
    await host.open(targetHost.uuid);
    await expect(host.inviteResult).toHaveCount(0);
    await host.runTest();
    await expect(host.inviteResult).toBeVisible();
    await expect(host.inviteResult).toHaveAttribute('data-invite-ok', /^(true|false)$/);
    await expect(host.inviteResult).toHaveText(/^Invites: (ready\.|not ready\. Missing .+|not used, .+|could not be checked\..*)$/);

    const tested = await AdminApi.asAdmin(request).post(`/hosts/${targetHost.uuid}/test-connection`);
    const ok = tested.body.inviteStatus === 'ready' || tested.body.inviteStatus === 'not-used';
    await expect(host.inviteResult).toHaveAttribute('data-invite-ok', ok ? 'true' : 'false');
    await expect(host.inviteResultUnderConnection).toBeVisible();
  });

  test('HINV-03 the host API invite-readiness endpoint refuses callers with no token and answers the Admin service client with names only', async ({
    request,
    hostUserInvitesApi,
  }) => {
    test.skip(!env.appApiUrl, 'APP_API_URL is not set.');
    const anonymous = await request.get(`${env.appApiUrl}/api/invite-readiness`);
    expect(anonymous.status()).toBe(401);

    const readiness = await hostUserInvitesApi.inviteReadiness();
    test.skip(readiness === null, 'ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET are not set.');
    expect(readiness!.status, readiness!.text).toBe(200);
    expect(readiness!.data).toEqual({ ready: expect.any(Boolean), missing: expect.any(Array) });
    expect(readiness!.data!.ready).toBe(readiness!.data!.missing.length === 0);
    for (const name of readiness!.data!.missing) {
      expect(name, 'a setting name, never a value').toMatch(/^[A-Za-z]+(:[A-Za-z]+)*$/);
    }
  });
});
