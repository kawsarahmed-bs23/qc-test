import { randomUUID } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import {
  canUseDriversDb,
  canUseIdentityDb,
  driversColumns,
  queryDriversDb,
  queryIdentityDb,
  runDriversSeedScript,
  runIdentitySeedScript,
} from '@utils/localDb';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { TRUCK_NUMBER_MAX } from '@api/driver-settings.api';
import { env } from '@config/env.config';

const DRIVER_EMAIL = 'e2e.qc902.driver@quarryconnect.test';
const AS_HAULED = {
  VendorUUID: randomUUID(),
  VendorName: 'E2E QC-902 Vendor',
  TruckUUID: randomUUID(),
  TruckName: 'E2E QC-902 Truck',
  HostName: 'E2E QC-902 Host as hauled',
  truckNumber: 'A-902',
};

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hasQc902Schema(): boolean {
  return (
    queryDriversDb(
      `SELECT CASE WHEN OBJECT_ID(N'app.DriverSettings', N'U') IS NOT NULL AND OBJECT_ID(N'auth.Organisations', N'U') IS NOT NULL AND COL_LENGTH(N'app.OrderAssignments', N'VendorUUID') IS NOT NULL THEN 1 ELSE 0 END`,
    ) === '1'
  );
}

function fingerprint(): string {
  return (
    queryDriversDb(
      `SELECT CONCAT(
        (SELECT COUNT(*) FROM auth.Organisations), '|', (SELECT COUNT(*) FROM auth.Users), '|', (SELECT COUNT(*) FROM auth.UserToRoles), '|',
        (SELECT COUNT(*) FROM app.DriverSettings), '|', (SELECT CHECKSUM_AGG(CHECKSUM(DriverSettingID, OrganisationID_FK, TruckNumber, Active)) FROM app.DriverSettings), '|',
        (SELECT COUNT(*) FROM app.DriverHostLinks), '|', (SELECT COUNT(*) FROM app.Messages), '|', (SELECT COUNT(*) FROM app.OrderAssignments), '|',
        (SELECT CHECKSUM_AGG(CHECKSUM(OrderAssignmentID, VendorUUID, VendorName, TruckUUID, TruckName, HostName, TruckNumber)) FROM app.OrderAssignments))`,
    ) ?? ''
  );
}

function linkedHostUuid(): string {
  return (
    queryDriversDb(
      `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE ${driversColumns().hostName} = ${sqlText(env.hostName)} AND Active = 1`,
    ) ?? ''
  );
}

function throwawaySubs(): string {
  return (
    (queryIdentityDb(`SELECT STRING_AGG(LOWER(Id), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC902.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none'
  );
}

function removeAll(userIds: string): void {
  runDriversSeedScript('drivers-qc902.remove.sql', { UserIds: userIds });
  runIdentitySeedScript('identity-qc902.remove.sql');
}

function storedTruckNumber(sub: string): string | null {
  return queryDriversDb(
    `SELECT ISNULL(s.TruckNumber, N'<null>') FROM app.DriverSettings s JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID = ${sqlText(sub)}`,
  );
}

function accountRows(sub: string): number {
  return Number(queryDriversDb(`SELECT COUNT(*) FROM auth.Users WHERE UserUUID = ${sqlText(sub)}`) ?? '0');
}

test.describe('Driver settings and the as-hauled assignment copy in DRIVERS (QC-902)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canUseDriversDb() || !canUseIdentityDb() || !env.driver || !env.driversApiUrl || !env.mobileClientId,
    'Needs DRIVERS_SQL_DATABASE, IDENTITY_SQL_DATABASE, DRIVER_EMAIL / DRIVER_PASSWORD, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
  );

  let baseline = '';
  let accessToken = '';
  let sub = '';
  let hostUuid = '';
  let assignmentUuid = '';

  const ensureAccount = () => {
    if (accountRows(sub) === 0) runDriversSeedScript('drivers-qc902-account.apply.sql', { UserId: sub, Email: DRIVER_EMAIL });
    expect(accountRows(sub), 'the throwaway driver has one Driver account').toBe(1);
  };

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    test.skip(!hasQc902Schema(), 'DRIVERS_SQL_DATABASE has no QC-902 migrations (022-026); point it at the QC-902 copy.');
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');

    hostUuid = linkedHostUuid();
    test.skip(!hostUuid, `HOST_NAME (${env.hostName}) is not an active host in DRIVERS_SQL_DATABASE.`);
    removeAll(throwawaySubs());
    baseline = fingerprint();

    runIdentitySeedScript('identity-qc902-user.apply.sql', { Email: DRIVER_EMAIL, SourceEmail: env.driver!.email, LastName: 'QC-902 Driver' });
    const grant = await new PasswordGrantApi(request).passwordGrant(DRIVER_EMAIL, env.driver!.password);
    expect(grant.status, `password grant: ${grant.body.error ?? ''} ${grant.body.error_description ?? ''}`).toBe(200);
    accessToken = grant.body.access_token!;
    sub = String(decodeJwt(accessToken).claims['sub']).toLowerCase();

    runDriversSeedScript('drivers-qc902.apply.sql', {
      UserId: sub,
      HostUuid: hostUuid,
      VendorUuid: AS_HAULED.VendorUUID,
      VendorName: AS_HAULED.VendorName,
      TruckUuid: AS_HAULED.TruckUUID,
      TruckName: AS_HAULED.TruckName,
      AsHauledHostName: AS_HAULED.HostName,
      AssignmentTruckNumber: AS_HAULED.truckNumber,
    });
    assignmentUuid = queryDriversDb(
      `SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE ${driversColumns().driverUser} = ${sqlText(sub)} AND Notes = N'e2e-qc902'`,
    )!;
    expect(assignmentUuid, 'the seeded as-hauled assignment').toBeTruthy();
  });

  test.afterAll(() => {
    if (!baseline) return;
    removeAll([sub, throwawaySubs()].filter((id) => id && id !== 'none').join(',') || 'none');
    expect(fingerprint(), 'the DRIVERS copy is back to its starting state').toBe(baseline);
    expect(throwawaySubs(), 'no e2e.qc902 Identity user is left').toBe('none');
  });

  test('DSET-01 GET and PUT /me/settings without a token are 401', async ({ driverSettingsApi }) => {
    expect((await driverSettingsApi.settings(null)).status).toBe(401);
    expect((await driverSettingsApi.saveSettings(null, { TruckNumber: 'T-902' })).status).toBe(401);
  });

  test('DSET-02 a driver with no Driver account gets 404 with an error from GET and PUT /me/settings, and nothing is created', async ({
    driverSettingsApi,
  }) => {
    const read = await driverSettingsApi.settings(accessToken);
    expect(read.status).toBe(404);
    expect(read.body.errors?.length ?? 0).toBeGreaterThan(0);

    const save = await driverSettingsApi.saveSettings(accessToken, { TruckNumber: 'T-902' });
    expect(save.status).toBe(404);
    expect(save.body.errors?.length ?? 0).toBeGreaterThan(0);
    expect(accountRows(sub)).toBe(0);
  });

  test('DSET-03 the thread list header truckNumber is null while the driver has no Driver account', async ({ driverSettingsApi }) => {
    const list = await driverSettingsApi.threads(accessToken);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data?.threads.map((t) => t.orderAssignmentUuid.toLowerCase())).toContain(assignmentUuid);
    expect(list.body.data?.truckNumber ?? null).toBeNull();
  });

  test('DSET-04 with a Driver account, PUT trims the truck number, GET returns it and the DriverSettings row holds it', async ({ driverSettingsApi }) => {
    ensureAccount();
    const empty = await driverSettingsApi.settings(accessToken);
    expect(empty.status).toBe(200);
    expect(empty.body.data?.TruckNumber ?? null).toBeNull();

    const save = await driverSettingsApi.saveSettings(accessToken, { TruckNumber: '  T-902  ' });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.data?.TruckNumber).toBe('T-902');

    const read = await driverSettingsApi.settings(accessToken);
    expect(read.status).toBe(200);
    expect(read.body.data?.TruckNumber).toBe('T-902');
    expect(storedTruckNumber(sub)).toBe('T-902');
  });

  test('DSET-05 a blank truck number is stored as null', async ({ driverSettingsApi }) => {
    ensureAccount();
    const save = await driverSettingsApi.saveSettings(accessToken, { TruckNumber: '   ' });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(save.body.data?.TruckNumber ?? null).toBeNull();
    expect((await driverSettingsApi.settings(accessToken)).body.data?.TruckNumber ?? null).toBeNull();
    expect(storedTruckNumber(sub)).toBe('<null>');
  });

  test('DSET-06 a truck number over 100 characters is 400 on TruckNumber and changes nothing; exactly 100 is saved', async ({ driverSettingsApi }) => {
    ensureAccount();
    expect((await driverSettingsApi.saveSettings(accessToken, { TruckNumber: 'T-902' })).status).toBe(200);

    const tooLong = await driverSettingsApi.saveSettings(accessToken, { TruckNumber: 'X'.repeat(TRUCK_NUMBER_MAX + 1) });
    expect(tooLong.status, JSON.stringify(tooLong.body)).toBe(400);
    expect(tooLong.body.validationErrors?.TruckNumber?.length ?? 0).toBeGreaterThan(0);
    expect(storedTruckNumber(sub)).toBe('T-902');

    const longest = 'Y'.repeat(TRUCK_NUMBER_MAX);
    const save = await driverSettingsApi.saveSettings(accessToken, { TruckNumber: longest });
    expect(save.status, JSON.stringify(save.body)).toBe(200);
    expect(storedTruckNumber(sub)).toBe(longest);
  });

  test('DSET-07 GET /sync and the assignment details return the as-hauled HostName, vendor, truck and truckNumber with the HostUUID of the row', async ({
    driverSettingsApi,
  }) => {
    const expected = { ...AS_HAULED, orderAssignmentUuid: assignmentUuid, HostUUID: hostUuid };
    const lower = (row: Record<string, unknown> | undefined) =>
      row && {
        ...row,
        orderAssignmentUuid: String(row.orderAssignmentUuid).toLowerCase(),
        HostUUID: String(row.HostUUID).toLowerCase(),
        VendorUUID: String(row.VendorUUID).toLowerCase(),
        TruckUUID: String(row.TruckUUID).toLowerCase(),
      };

    const sync = await driverSettingsApi.syncAssignments(accessToken);
    expect(sync.status, JSON.stringify(sync.body)).toBe(200);
    const synced = sync.body.data?.assignments.find((a) => a.orderAssignmentUuid.toLowerCase() === assignmentUuid);
    expect(lower(synced as unknown as Record<string, unknown>)).toMatchObject(expected);

    const details = await driverSettingsApi.assignment(accessToken, assignmentUuid);
    expect(details.status, JSON.stringify(details.body)).toBe(200);
    expect(lower(details.body.data as unknown as Record<string, unknown>)).toMatchObject(expected);
  });

  test('DSET-08 the thread list header truckNumber is the Driver settings truck number; a single thread shows the assignment truck number', async ({
    driverSettingsApi,
  }) => {
    ensureAccount();
    expect((await driverSettingsApi.saveSettings(accessToken, { TruckNumber: 'T-902' })).status).toBe(200);

    const list = await driverSettingsApi.threads(accessToken);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data?.truckNumber).toBe('T-902');

    const thread = await driverSettingsApi.thread(accessToken, assignmentUuid);
    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    expect(thread.body.data?.truckNumber).toBe(AS_HAULED.truckNumber);
  });
});
