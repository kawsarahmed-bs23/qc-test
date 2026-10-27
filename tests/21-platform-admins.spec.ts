import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures/test';
import { canUseMasterDb, queryMasterDb } from '../fixtures/localDb';
import { adminAccount, canSeedThrowawayUsers, removeQc823PlatformAdmins, removeQc823Users, seedQc823User } from '../fixtures/throwawayUsers';
import { AdminApi, adminTokenFromState, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { decodeJwt } from '../pages/PasswordGrantApi';
import { PlatformAdminsPage, reportScreenshotPath } from '../pages/PlatformPages';

const CANDIDATE_EMAIL = 'e2e.qc823.candidate@quarryconnect.test';
const CANDIDATE_NAME = 'E2E QC-823 Candidate';
const DEACTIVATED_EMAIL = 'e2e.qc823.deactivated@quarryconnect.test';
const UNKNOWN_UUID = '00000000-0000-0000-0000-000000000001';
const ADMIN_KEYS = ['userUuid', 'displayName', 'email', 'active', 'added', 'updated', 'updatedBy', 'isYou', 'canDeactivate'];

interface PlatformAdminRow {
  userUuid: string;
  displayName: string;
  email: string | null;
  active: boolean;
  isYou: boolean;
  canDeactivate: boolean;
}

function myUserUuid(): string {
  return String(decodeJwt(adminTokenFromState()).claims.sub).toLowerCase();
}

function platformAdminSnapshot(): string | null {
  return queryMasterDb(
    "SELECT STRING_AGG(CONCAT(PlatformAdminID, '|', UserUUID, '|', DisplayName, '|', Active, '|', CONVERT(varchar(23), Updated, 121), '|', UpdatedBy), ';') WITHIN GROUP (ORDER BY PlatformAdminID) FROM app.PlatformAdmins WHERE DisplayName NOT LIKE N'E2E QC-%'",
  );
}

function rowsFor(userUuid: string): string | null {
  return queryMasterDb(`SELECT CONCAT(COUNT(*), '|', SUM(CAST(Active AS int))) FROM app.PlatformAdmins WHERE UserUUID = '${userUuid}'`);
}

function adminChangeLogs(since: number): string[] {
  return (queryMasterDb(`SELECT Summary + N'|' + CreatedBy FROM app.ChangeLogs WHERE ChangeLogID > ${since} AND Area = N'Admins' ORDER BY ChangeLogID`) ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

test.describe('Platform admins (QC-823)', () => {
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');

  test('PADM-01 the Admins page lists the platform admins and marks the signed-in admin "You" with Remove disabled', async ({ page, shell, request }) => {
    const me = myUserUuid();
    const admins = new PlatformAdminsPage(page);
    await page.goto(adminUrl('/'));
    await shell.nav('admins').click();
    await expect(page).toHaveURL(adminUrl('/admins'));
    await expect(shell.heading).toHaveText('Admins');
    await expect(admins.rows.first()).toBeVisible();

    await expect(admins.you(me)).toHaveText('You');
    await expect(page.locator('[data-testid="admin-you"]')).toHaveCount(1);
    await expect(admins.status(me)).toHaveText('Active');
    await expect(admins.deactivate(me)).toBeDisabled();
    await expect(admins.deactivate(me)).toHaveAttribute('title', 'You cannot remove yourself.');

    const list = await AdminApi.asAdmin(request).get<PlatformAdminRow[]>('/admins');
    expect(list.status).toBe(200);
    await expect(admins.rows).toHaveCount(list.body.length);
    for (const admin of list.body) {
      expect(Object.keys(admin).sort()).toEqual([...ADMIN_KEYS].sort());
      expect(admin.isYou, admin.displayName).toBe(admin.userUuid.toLowerCase() === me);
    }
    const mine = list.body.find((admin) => admin.isYou)!;
    expect(mine).toMatchObject({ active: true, canDeactivate: false, email: adminAccount()!.email });
    const others = list.body.filter((admin) => admin.active && !admin.isYou);
    expect(others.length, 'there is another active admin').toBeGreaterThan(0);
    for (const other of others) {
      expect(other.canDeactivate, other.displayName).toBe(true);
      await expect(admins.deactivate(other.userUuid)).toBeEnabled();
    }

    fs.mkdirSync(path.dirname(reportScreenshotPath('admins.png')), { recursive: true });
    await page.screenshot({ path: reportScreenshotPath('admins.png'), fullPage: true });
  });

  test.describe('with throwaway Identity users', () => {
    test.skip(!canSeedThrowawayUsers() || !canUseMasterDb(), "Needs Identity's and HOST_MASTER's local databases for throwaway e2e.qc823.* users.");

    let original: string | null = null;

    test.beforeAll(() => {
      original = platformAdminSnapshot();
      removeQc823PlatformAdmins();
      removeQc823Users();
    });

    test.afterAll(() => {
      removeQc823PlatformAdmins();
      removeQc823Users();
      expect(platformAdminSnapshot(), 'the shared platform admin rows are unchanged').toBe(original);
    });

    test('PADM-02 an Identity user found by search is added as admin, removed and restored on the page, with one row and an activity entry for each step', { tag: '@write' }, async ({ page, shell, request }) => {
      const candidate = seedQc823User(CANDIDATE_EMAIL, 'QC-823 Candidate');
      const uuid = candidate.userId.toLowerCase();
      const since = Number(queryMasterDb('SELECT ISNULL(MAX(ChangeLogID), 0) FROM app.ChangeLogs'));
      const admins = new PlatformAdminsPage(page);
      const actor = adminAccount()!.email;

      try {
        await admins.open();
        await expect(admins.row(uuid)).toHaveCount(0);

        await admins.search.fill('e');
        await expect(admins.candidates).toHaveCount(0);
        await admins.search.fill('e2e.qc823.cand');
        await expect(admins.candidate(uuid)).toContainText(CANDIDATE_EMAIL);
        await admins.candidateAdd(uuid).click();
        await expect(shell.confirmDialog.title).toHaveText(`Make ${CANDIDATE_NAME} a platform admin?`);
        await shell.confirmDialog.accept();
        await shell.expectStatus(`${CANDIDATE_NAME} can now use the Admin site.`);
        await expect(admins.status(uuid)).toHaveText('Active');
        await expect(admins.row(uuid)).toContainText(CANDIDATE_EMAIL);
        await expect(admins.deactivate(uuid)).toBeEnabled();
        expect(rowsFor(uuid)).toBe('1|1');

        await expect(admins.search).toHaveValue('');
        await admins.search.fill(CANDIDATE_EMAIL);
        await expect(admins.candidateIsAdmin(uuid)).toHaveText('Admin');
        await expect(admins.candidateAdd(uuid)).toHaveCount(0);
        await admins.search.fill('');

        await admins.deactivate(uuid).click();
        await expect(shell.confirmDialog.title).toHaveText(`Remove ${CANDIDATE_NAME}?`);
        await shell.confirmDialog.accept();
        await shell.expectStatus(`${CANDIDATE_NAME} can no longer use the Admin site.`);
        await expect(admins.status(uuid)).toHaveText('Removed');
        await expect(admins.reactivate(uuid)).toBeEnabled();
        expect(rowsFor(uuid)).toBe('1|0');

        await admins.reactivate(uuid).click();
        await expect(shell.confirmDialog.title).toHaveText(`Restore ${CANDIDATE_NAME}?`);
        await shell.confirmDialog.accept();
        await shell.expectStatus(`${CANDIDATE_NAME} can use the Admin site again.`);
        await expect(admins.status(uuid)).toHaveText('Active');
        expect(rowsFor(uuid)).toBe('1|1');

        const api = AdminApi.asAdmin(request);
        expect((await api.post(`/admins/${uuid}/deactivate`)).status).toBe(200);
        const readd = await api.post('/admins', { userUuid: uuid });
        expect(readd.status, 'adding an old inactive admin reactivates the same row').toBe(200);
        expect(rowsFor(uuid)).toBe('1|1');

        expect(adminChangeLogs(since)).toEqual([
          `Added platform admin ${CANDIDATE_NAME}|${actor}`,
          `Deactivated platform admin ${CANDIDATE_NAME}|${actor}`,
          `Reactivated platform admin ${CANDIDATE_NAME}|${actor}`,
          `Deactivated platform admin ${CANDIDATE_NAME}|${actor}`,
          `Added platform admin ${CANDIDATE_NAME}|${actor}`,
        ]);
      } finally {
        removeQc823PlatformAdmins();
      }
      expect(rowsFor(uuid)).toBe('0|');
    });

    test('PADM-03 the API refuses to remove yourself, an unknown or inactive admin, and to add an unknown, deactivated or existing admin', { tag: '@write' }, async ({ request }) => {
      const api = AdminApi.asAdmin(request);
      const me = myUserUuid();
      const candidate = seedQc823User(CANDIDATE_EMAIL, 'QC-823 Candidate');
      const deactivated = seedQc823User(DEACTIVATED_EMAIL, 'QC-823 Deactivated', false);

      try {
        const self = await api.post(`/admins/${me}/deactivate`);
        expect(self.status).toBe(400);
        expect(self.text).toContain('You cannot remove yourself.');
        expect(rowsFor(me)).toBe('1|1');

        expect((await api.post(`/admins/${UNKNOWN_UUID}/deactivate`)).status).toBe(404);
        expect((await api.post(`/admins/${UNKNOWN_UUID}/reactivate`)).status).toBe(404);

        const unknown = await api.post('/admins', { userUuid: UNKNOWN_UUID });
        expect(unknown.status).toBe(400);
        expect(unknown.text).toContain('That user does not exist in Identity.');

        const empty = await api.post('/admins', {});
        expect(empty.status).toBe(400);

        const inactive = await api.post('/admins', { userUuid: deactivated.userId });
        expect(inactive.status).toBe(400);
        expect(inactive.text).toContain('That account is deactivated in Identity.');
        expect(rowsFor(deactivated.userId)).toBe('0|');

        const existing = await api.post('/admins', { userUuid: me });
        expect(existing.status).toBe(400);
        expect(existing.text).toContain('is already a platform admin.');

        expect((await api.post('/admins', { userUuid: candidate.userId })).status).toBe(200);
        expect((await api.post(`/admins/${candidate.userId}/reactivate`)).status).toBe(400);
        expect((await api.post(`/admins/${candidate.userId}/deactivate`)).status).toBe(200);
        const again = await api.post(`/admins/${candidate.userId}/deactivate`);
        expect(again.status).toBe(400);
        expect(again.text).toContain('That admin is already deactivated.');
      } finally {
        removeQc823PlatformAdmins();
      }
    });

    test('PADM-04 the last active platform admin cannot be removed', { tag: '@write' }, async () => {
      test.skip(
        true,
        'Not reachable from outside: the caller is always an active admin, so removing anyone else leaves at least two active, and removing yourself is refused first (PADM-03). Forcing it would mean deactivating the shared admin accounts.',
      );
    });
  });
});
