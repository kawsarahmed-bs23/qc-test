import { test, expect } from '@fixtures/pageFixtures';
import { canUseDriversDb, canUseIdentityDb, queryDriversDb, queryIdentityDb, runDriversSeedScript, runIdentitySeedScript } from '@utils/localDb';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { PENDING_DELETION_MESSAGE, RESTORE_DAYS, UTC_WHOLE_SECONDS, type AccountDeletion } from '@api/account-deletion.api';
import { env } from '@config/env.config';

const DRIVER_EMAIL = 'e2e.qc902.deletion@quarryconnect.test';
const PURGE = {
  due: 'e2e90201-0902-4902-a902-000000000001',
  future: 'e2e90201-0902-4902-a902-000000000002',
  restored: 'e2e90201-0902-4902-a902-000000000003',
};
const OTHER_DRIVER = '099d0449-2094-4323-a644-6a63c49ba30e';
const DAY_MS = 86_400_000;
const PURGE_WINDOW = 150_000;

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hasDeletionSchema(): boolean {
  return (
    queryDriversDb(
      `SELECT CASE WHEN OBJECT_ID(N'app.DriverDeletions', N'U') IS NOT NULL AND COL_LENGTH(N'app.DriverSettings', N'DeletionRequestedAt') IS NOT NULL THEN 1 ELSE 0 END`,
    ) === '1'
  );
}

function fingerprint(): string {
  return (
    queryDriversDb(
      `SELECT CONCAT(
        (SELECT COUNT(*) FROM auth.Organisations), '|', (SELECT COUNT(*) FROM auth.Users), '|', (SELECT COUNT(*) FROM auth.UserToRoles), '|',
        (SELECT COUNT(*) FROM app.DriverSettings), '|',
        (SELECT CHECKSUM_AGG(CHECKSUM(DriverSettingID, OrganisationID_FK, TruckNumber, Active, DeletionRequestedAt, DeletionScheduledFor, DeletionCanceledAt)) FROM app.DriverSettings), '|',
        (SELECT COUNT(*) FROM app.DriverHostLinks), '|', (SELECT CHECKSUM_AGG(CHECKSUM(DriverHostLinkID, UserUUID, HostUUID, Active)) FROM app.DriverHostLinks), '|',
        (SELECT COUNT(*) FROM app.OrderAssignments), '|', (SELECT COUNT(*) FROM app.Trips), '|', (SELECT COUNT(*) FROM app.Tickets), '|',
        (SELECT COUNT(*) FROM app.Messages), '|', (SELECT COUNT(*) FROM app.DeviceTokens), '|', (SELECT COUNT(*) FROM app.DriverInvites), '|',
        (SELECT COUNT(*) FROM app.DriverCommands), '|', (SELECT COUNT(*) FROM app.SyncTombstones), '|', (SELECT COUNT(*) FROM app.DriverDeletions))`,
    ) ?? ''
  );
}

function driverRows(userUuid: string): string {
  const key = sqlText(userUuid.toLowerCase());
  const uuid = `CONVERT(uniqueidentifier, ${key})`;
  return (
    queryDriversDb(
      `SELECT CONCAT(
        (SELECT COUNT(*) FROM auth.Users WHERE UserUUID = ${key}), '|',
        (SELECT COUNT(*) FROM app.DriverSettings s JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID = ${key}), '|',
        (SELECT COUNT(*) FROM app.OrderAssignments WHERE DriverUserUUID = ${uuid}), '|', (SELECT COUNT(*) FROM app.Trips WHERE UserUUID = ${uuid}), '|',
        (SELECT COUNT(*) FROM app.Tickets WHERE UserUUID = ${uuid}), '|', (SELECT COUNT(*) FROM app.Messages WHERE DriverUserUUID = ${uuid}), '|',
        (SELECT COUNT(*) FROM app.DeviceTokens WHERE UserUUID = ${uuid}), '|', (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID = ${uuid}), '|',
        (SELECT COUNT(*) FROM app.DriverInvites WHERE InvitedUserID = ${key}), '|', (SELECT COUNT(*) FROM app.DriverCommands WHERE UserUUID = ${uuid}), '|',
        (SELECT COUNT(*) FROM app.SyncTombstones WHERE UserUUID = ${uuid}))`,
    ) ?? ''
  );
}

function deletionHashRows(userUuid: string): string {
  return (
    queryDriversDb(
      `SELECT CONCAT(COUNT(*), '|', MAX(CONVERT(varchar(10), DeletedOn, 23)), '|', MAX(CreatedBy), '|', CONVERT(varchar(10), CONVERT(date, GETUTCDATE()), 23))
       FROM app.DriverDeletions WHERE UserUUIDHash = HASHBYTES('SHA2_256', CONVERT(varbinary(100), '${userUuid.toUpperCase()}'))`,
    ) ?? ''
  );
}

function storedDeletion(sub: string): { requestedAt: string | null; scheduledFor: string | null; canceledAt: string | null; truckNumber: string | null } {
  const iso = (column: string) => `ISNULL(CONVERT(varchar(30), s.${column}, 126) + 'Z', '<null>')`;
  const row = queryDriversDb(
    `SELECT CONCAT(${iso('DeletionRequestedAt')}, '|', ${iso('DeletionScheduledFor')}, '|', ${iso('DeletionCanceledAt')}, '|', ISNULL(s.TruckNumber, N'<null>'))
     FROM app.DriverSettings s JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID = ${sqlText(sub)}`,
  );
  const [requestedAt, scheduledFor, canceledAt, truckNumber] = (row ?? '<null>|<null>|<null>|<null>').split('|').map((v) => (v === '<null>' ? null : v));
  return { requestedAt, scheduledFor, canceledAt, truckNumber };
}

function accountRows(sub: string): number {
  return Number(queryDriversDb(`SELECT COUNT(*) FROM auth.Users WHERE UserUUID = ${sqlText(sub)}`) ?? '0');
}

function linkedHostUuid(): string {
  return queryDriversDb(`SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = ${sqlText(env.hostName)} AND Active = 1`) ?? '';
}

function throwawaySubs(): string {
  return (
    (queryIdentityDb(`SELECT STRING_AGG(LOWER(Id), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC902.DELETION%@QUARRYCONNECT.TEST'`) ?? 'none') ||
    'none'
  );
}

function removeAll(userIds: string[]): void {
  const ids = [...userIds, ...Object.values(PURGE)].filter((id) => id && id !== 'none');
  runDriversSeedScript('drivers-qc902-deletion.remove.sql', { UserIds: ids.join(',') || 'none' });
  runIdentitySeedScript('identity-qc902.remove.sql');
}

function expectUtcSeconds(value: string | null | undefined): void {
  expect(value ?? '', 'a UTC time with a Z and whole seconds').toMatch(UTC_WHOLE_SECONDS);
}

function expectPendingDeletion(body: { data?: unknown; message?: string | null }, requested: AccountDeletion): void {
  const data = body.data as AccountDeletion | undefined;
  expect(body.message).toBe(PENDING_DELETION_MESSAGE);
  expect(data?.Status).toBe('pending');
  expect(data?.DeletionRequestedAt).toBe(requested.DeletionRequestedAt);
  expect(data?.DeletionScheduledFor).toBe(requested.DeletionScheduledFor);
}

test.describe('Driver account deletion with a 30-day restore window and the purge (QC-902 part 2)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canUseDriversDb() || !canUseIdentityDb() || !env.driver || !env.driversApiUrl || !env.mobileClientId,
    'Needs DRIVERS_SQL_DATABASE, IDENTITY_SQL_DATABASE, DRIVER_EMAIL / DRIVER_PASSWORD, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
  );

  let baseline = '';
  let sharedDriverBefore = '';
  let otherDriverBefore = '';
  let accessToken = '';
  let sub = '';
  let hostUuid = '';
  let requested: AccountDeletion | undefined;
  let restored: AccountDeletion | undefined;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    test.skip(!hasDeletionSchema(), 'DRIVERS_SQL_DATABASE has no QC-902 deletion migrations (032-033); point it at the QC-902 copy.');
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');

      hostUuid = linkedHostUuid();
      test.skip(!hostUuid, `HOST_NAME (${env.hostName}) is not an active host in DRIVERS_SQL_DATABASE.`);
      removeAll([throwawaySubs()]);
      baseline = fingerprint();
      sharedDriverBefore = queryDriversDb(
        `SELECT CONCAT(LOWER(CONVERT(nvarchar(36), u.UserUUID)), '|', s.DeletionRequestedAt, '|', s.DeletionScheduledFor, '|', s.DeletionCanceledAt, '|', s.Updated, '|', s.UpdatedBy)
         FROM auth.Users u JOIN app.DriverSettings s ON s.OrganisationID_FK = u.OrganisationIdFk WHERE u.NormalizedEmail = UPPER(${sqlText(env.driver!.email)})`,
      )!;
      otherDriverBefore = driverRows(OTHER_DRIVER);

      runIdentitySeedScript('identity-qc902-user.apply.sql', { Email: DRIVER_EMAIL, SourceEmail: env.driver!.email, LastName: 'QC-902 Deletion Driver' });
      const grant = await new PasswordGrantApi(request).passwordGrant(DRIVER_EMAIL, env.driver!.password);
      expect(grant.status, `password grant: ${grant.body.error ?? ''} ${grant.body.error_description ?? ''}`).toBe(200);
      accessToken = grant.body.access_token!;
      sub = String(decodeJwt(accessToken).claims['sub']).toLowerCase();
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(() => {
    if (!baseline) return;
    removeAll([sub, throwawaySubs()]);
    expect(fingerprint(), 'the DRIVERS copy is back to its starting state').toBe(baseline);
    expect(throwawaySubs(), 'no e2e.qc902.deletion Identity user is left').toBe('none');
  });

  test('DEL-01 GET, POST and DELETE /me/deletion without a token are 401', async ({ accountDeletionApi }) => {
    expect((await accountDeletionApi.status(null)).status).toBe(401);
    expect((await accountDeletionApi.requestDeletion(null)).status).toBe(401);
    expect((await accountDeletionApi.restore(null)).status).toBe(401);
  });

  test('DEL-02 a driver with no Driver account and no host link gets 404 with an error from GET, POST and DELETE, and nothing is created', async ({
    accountDeletionApi,
  }) => {
    for (const call of [accountDeletionApi.status, accountDeletionApi.requestDeletion, accountDeletionApi.restore]) {
      const answer = await call.call(accountDeletionApi, accessToken);
      expect(answer.status, JSON.stringify(answer.body)).toBe(404);
      expect(answer.body.errors?.length ?? 0).toBeGreaterThan(0);
    }
    expect(accountRows(sub)).toBe(0);
  });

  test('DEL-03 with a Driver account and a host link, GET is none with no dates and RestoreDays 30, and the other routes answer', async ({
    accountDeletionApi,
  }) => {
    runDriversSeedScript('drivers-qc902-deletion-link.apply.sql', { UserId: sub, HostUuid: hostUuid });
    runDriversSeedScript('drivers-qc902-account.apply.sql', { UserId: sub, Email: DRIVER_EMAIL });

    const status = await accountDeletionApi.status(accessToken);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data).toEqual({
      Status: 'none',
      DeletionRequestedAt: null,
      DeletionScheduledFor: null,
      DeletionCanceledAt: null,
      RestoreDays: RESTORE_DAYS,
    });

    expect((await accountDeletionApi.hosts(accessToken)).status).toBe(200);
    expect((await accountDeletionApi.settings(accessToken)).status).toBe(200);
    expect((await accountDeletionApi.invites(accessToken)).status).toBe(200);
  });

  test('DEL-04 POST makes the deletion pending for 30 days in whole UTC seconds, the row agrees, and a second POST keeps the same dates', async ({
    accountDeletionApi,
  }) => {
    const before = Date.now();
    const first = await accountDeletionApi.requestDeletion(accessToken);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    requested = first.body.data!;
    expect(requested.Status).toBe('pending');
    expect(requested.RestoreDays).toBe(RESTORE_DAYS);
    expect(requested.DeletionCanceledAt).toBeNull();
    expectUtcSeconds(requested.DeletionRequestedAt);
    expectUtcSeconds(requested.DeletionScheduledFor);
    const requestedMs = Date.parse(requested.DeletionRequestedAt!);
    expect(Math.abs(requestedMs - before), 'DeletionRequestedAt is now').toBeLessThan(60_000);
    expect(Date.parse(requested.DeletionScheduledFor!) - requestedMs).toBe(RESTORE_DAYS * DAY_MS);

    expect(storedDeletion(sub)).toMatchObject({
      requestedAt: requested.DeletionRequestedAt,
      scheduledFor: requested.DeletionScheduledFor,
      canceledAt: null,
    });

    const again = await accountDeletionApi.requestDeletion(accessToken);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toEqual(requested);
    expect((await accountDeletionApi.status(accessToken)).body.data).toEqual(requested);
  });

  test('DEL-05 while pending, /me/hosts, /me/settings and /invites are 403 with Status pending and the restore message, and PUT changes nothing', async ({
    accountDeletionApi,
  }) => {
    test.skip(!requested, 'DEL-04 did not make the deletion pending.');
    const truckBefore = storedDeletion(sub).truckNumber;

    for (const answer of [
      await accountDeletionApi.hosts(accessToken),
      await accountDeletionApi.settings(accessToken),
      await accountDeletionApi.saveSettings(accessToken, { TruckNumber: 'DEL-902' }),
      await accountDeletionApi.invites(accessToken),
    ]) {
      expect(answer.status, JSON.stringify(answer.body)).toBe(403);
      expectPendingDeletion(answer.body, requested!);
    }
    expect(storedDeletion(sub).truckNumber).toBe(truckBefore);

    const status = await accountDeletionApi.status(accessToken);
    expect(status.status).toBe(200);
    expect(status.body.data?.Status).toBe('pending');
  });

  test('DEL-06 DELETE restores the account (Status none, DeletionCanceledAt set), the routes answer again, and a second DELETE is 200 too', async ({
    accountDeletionApi,
  }) => {
    test.skip(!requested, 'DEL-04 did not make the deletion pending.');
    const restore = await accountDeletionApi.restore(accessToken);
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);
    restored = restore.body.data!;
    expect(restored.Status).toBe('none');
    expectUtcSeconds(restored.DeletionCanceledAt);
    expect(Date.parse(restored.DeletionCanceledAt!)).toBeGreaterThanOrEqual(Date.parse(requested!.DeletionRequestedAt!));
    expect(storedDeletion(sub).canceledAt).toBe(restored.DeletionCanceledAt);

    expect((await accountDeletionApi.hosts(accessToken)).status).toBe(200);
    expect((await accountDeletionApi.settings(accessToken)).status).toBe(200);
    expect((await accountDeletionApi.invites(accessToken)).status).toBe(200);

    const again = await accountDeletionApi.restore(accessToken);
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.data).toEqual(restored);
  });

  test('DEL-07 a new POST after a restore starts fresh dates with DeletionCanceledAt null', async ({ accountDeletionApi }) => {
    test.skip(!restored, 'DEL-06 did not restore the account.');
    const canceledMs = Date.parse(restored!.DeletionCanceledAt!);
    await expect.poll(() => Date.now(), { message: 'the clock moves past the restore second' }).toBeGreaterThanOrEqual(canceledMs + 1_000);

    try {
      const fresh = await accountDeletionApi.requestDeletion(accessToken);
      expect(fresh.status, JSON.stringify(fresh.body)).toBe(200);
      const data = fresh.body.data!;
      expect(data.Status).toBe('pending');
      expect(data.DeletionCanceledAt).toBeNull();
      expect(Date.parse(data.DeletionRequestedAt!)).toBeGreaterThan(canceledMs);
      expect(Date.parse(data.DeletionScheduledFor!) - Date.parse(data.DeletionRequestedAt!)).toBe(RESTORE_DAYS * DAY_MS);
      expect(storedDeletion(sub)).toMatchObject({ requestedAt: data.DeletionRequestedAt, scheduledFor: data.DeletionScheduledFor, canceledAt: null });
    } finally {
      expect((await accountDeletionApi.restore(accessToken)).body.data?.Status).toBe('none');
    }
  });

  test('DEL-08 the purge removes every DRIVERS row of a driver past DeletionScheduledFor, keeps one hash row, and leaves restored, not-yet-due and other drivers alone', async () => {
    test.setTimeout(PURGE_WINDOW + 60_000);
    const sharedSub = sharedDriverBefore.split('|')[0];
    const sharedRowsBefore = driverRows(sharedSub);
    const throwawayRowsBefore = driverRows(sub);

    runDriversSeedScript('drivers-qc902-purge.apply.sql', {
      DueUserId: PURGE.due,
      FutureUserId: PURGE.future,
      RestoredUserId: PURGE.restored,
      HostUuid: hostUuid,
    });
    const keptFuture = driverRows(PURGE.future);
    const keptRestored = driverRows(PURGE.restored);
    expect(keptFuture.startsWith('1|1|'), `the not-yet-due driver is seeded (${keptFuture})`).toBe(true);

    await expect
      .poll(() => driverRows(PURGE.due), { message: 'the purge removes the due driver', timeout: PURGE_WINDOW, intervals: [5_000] })
      .toBe('0|0|0|0|0|0|0|0|0|0|0');

    const [count, deletedOn, createdBy, todayUtc] = deletionHashRows(PURGE.due).split('|');
    expect(count, 'one DriverDeletions row for the purged UUID').toBe('1');
    expect(deletedOn).toBe(todayUtc);
    expect(createdBy).toBe('drivers-purge');

    expect(driverRows(PURGE.future), 'a pending driver that is not due yet keeps its rows').toBe(keptFuture);
    expect(driverRows(PURGE.restored), 'a restored driver keeps its rows').toBe(keptRestored);
    expect(deletionHashRows(PURGE.future).split('|')[0]).toBe('0');
    expect(deletionHashRows(PURGE.restored).split('|')[0]).toBe('0');
    expect(driverRows(OTHER_DRIVER), `driver ${OTHER_DRIVER} keeps its rows`).toBe(otherDriverBefore);
    expect(driverRows(sharedSub), 'the DRIVER_EMAIL driver keeps its rows').toBe(sharedRowsBefore);
    expect(driverRows(sub), 'the restored throwaway driver keeps its rows').toBe(throwawayRowsBefore);
  });

  test('DEL-09 the DRIVER_EMAIL driver is untouched: GET /me/deletion is none, its link is active and its DriverSettings deletion columns are unchanged', async ({
    accountDeletionApi,
    passwordGrantApi,
  }) => {
    const grant = await passwordGrantApi.passwordGrant(env.driver!.email, env.driver!.password);
    expect(grant.status, `password grant: ${grant.body.error ?? ''} ${grant.body.error_description ?? ''}`).toBe(200);
    const sharedSub = String(decodeJwt(grant.body.access_token!).claims['sub']).toLowerCase();
    expect(sharedSub).toBe(sharedDriverBefore.split('|')[0]);

    const status = await accountDeletionApi.status(grant.body.access_token!);
    expect(status.status, JSON.stringify(status.body)).toBe(200);
    expect(status.body.data?.Status).toBe('none');
    expect(
      queryDriversDb(`SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID = CONVERT(uniqueidentifier, ${sqlText(sharedSub)}) AND Active = 1`),
    ).not.toBe('0');
    expect(
      queryDriversDb(
        `SELECT CONCAT(LOWER(CONVERT(nvarchar(36), u.UserUUID)), '|', s.DeletionRequestedAt, '|', s.DeletionScheduledFor, '|', s.DeletionCanceledAt, '|', s.Updated, '|', s.UpdatedBy)
         FROM auth.Users u JOIN app.DriverSettings s ON s.OrganisationID_FK = u.OrganisationIdFk WHERE u.NormalizedEmail = UPPER(${sqlText(env.driver!.email)})`,
      ),
    ).toBe(sharedDriverBefore);
  });
});
