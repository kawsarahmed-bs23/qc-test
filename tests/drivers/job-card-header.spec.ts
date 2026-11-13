import { test, expect } from '@fixtures/pageFixtures';
import { canUseDriversDb, canUseIdentityDb, queryDriversDb, queryIdentityDb, runDriversSeedScript, runIdentitySeedScript } from '@utils/localDb';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import type { AsHauledAssignment, DriverSettingsApi } from '@api/driver-settings.api';
import { env } from '@config/env.config';

const DRIVER_EMAIL = 'e2e.qc938.driver@quarryconnect.test';
const VENDOR = 'E2E QC-938 Delgado Hauling';
const FIRST_HOST = 'E2E QC-938 Statewide Materials';
const FIRST_AS_HAULED = 'E2E QC-938 Statewide Materials (as hauled)';
const SECOND_AS_HAULED = 'E2E QC-938 Second Host (as hauled)';

type Role = 'offer' | 'accepted' | 'second host' | 'no vendor' | 'no truck';
const ROLES: Role[] = ['offer', 'accepted', 'second host', 'no vendor', 'no truck'];

interface CardFields {
  VendorName: string | null;
  truckNumber: string | null;
  HostName: string | null;
  HostUUID: string;
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hasQc938Schema(): boolean {
  return (
    queryDriversDb(
      `SELECT CASE WHEN COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL AND COL_LENGTH(N'app.OrderAssignments', N'VendorName') IS NOT NULL AND COL_LENGTH(N'app.OrderAssignments', N'HostName') IS NOT NULL THEN 1 ELSE 0 END`,
    ) === '1'
  );
}

function throwawaySubs(): string {
  return (
    (queryIdentityDb(`SELECT STRING_AGG(LOWER(Id), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC938.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none'
  );
}

function removeAll(userIds: string): string {
  const removed = runDriversSeedScript('drivers-qc938.remove.sql', { UserIds: userIds });
  runIdentitySeedScript('identity-qc938.remove.sql');
  return removed;
}

function leftInDrivers(): string | null {
  return queryDriversDb(
    `SELECT CONCAT((SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc938%'), '|', (SELECT COUNT(*) FROM app.Hosts WHERE HostName LIKE N'E2E QC-938%'))`,
  );
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

function card(row: AsHauledAssignment | undefined): CardFields | undefined {
  return (
    row && {
      VendorName: row.VendorName,
      truckNumber: row.truckNumber,
      HostName: row.HostName,
      HostUUID: String(row.HostUUID).toLowerCase(),
    }
  );
}

test.describe(
  'Driver App Job card header: Vendor and Truck first, Booked by Host second, from the Drivers API (QC-938, D109)',
  { tag: ['@write', '@regression'] },
  () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(
      !canUseDriversDb() || !canUseIdentityDb() || !env.driver || !env.driversApiUrl || !env.mobileClientId,
      'Needs DRIVERS_SQL_DATABASE, IDENTITY_SQL_DATABASE, DRIVER_EMAIL / DRIVER_PASSWORD, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
    );

    let accessToken = '';
    let sub = '';
    let today = '';
    const uuids = {} as Record<Role, string>;
    const hosts = { first: '', second: '' };

    const expected = (role: Role): CardFields => {
      const first = { HostUUID: hosts.first };
      switch (role) {
        case 'offer':
          return { ...first, VendorName: VENDOR, truckNumber: '938-P', HostName: FIRST_AS_HAULED };
        case 'accepted':
          return { ...first, VendorName: VENDOR, truckNumber: '101', HostName: FIRST_AS_HAULED };
        case 'second host':
          return { HostUUID: hosts.second, VendorName: VENDOR, truckNumber: '101', HostName: SECOND_AS_HAULED };
        case 'no vendor':
          return { ...first, VendorName: null, truckNumber: null, HostName: FIRST_HOST };
        case 'no truck':
          return { ...first, VendorName: VENDOR, truckNumber: null, HostName: FIRST_AS_HAULED };
      }
    };

    const sources = async (api: DriverSettingsApi, role: Role) => {
      const sync = await api.syncAssignments(accessToken);
      expect(sync.status, JSON.stringify(sync.body)).toBe(200);
      const list = await api.myAssignments(accessToken, today);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const details = await api.assignment(accessToken, uuids[role]);
      expect(details.status, `details of the ${role} job: ${JSON.stringify(details.body)}`).toBe(200);
      const find = (rows: AsHauledAssignment[] | undefined) => rows?.find((row) => row.orderAssignmentUuid.toLowerCase() === uuids[role]);
      return {
        sync: card(find(sync.body.data?.assignments)),
        list: card(find(list.body.data?.data)),
        details: card(details.body.data ?? undefined),
      };
    };

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(120_000);
      test.skip(!hasQc938Schema(), 'DRIVERS_SQL_DATABASE has no QC-902 one-list columns (VendorName, HostName, UserUUID); point it at a migrated copy.');
      const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
        removeAll(throwawaySubs());

        runIdentitySeedScript('identity-qc938-user.apply.sql', { Email: DRIVER_EMAIL, SourceEmail: env.driver!.email, LastName: 'QC-938 Driver' });
        const grant = await new PasswordGrantApi(request).passwordGrant(DRIVER_EMAIL, env.driver!.password);
        expect(grant.status, `password grant: ${grant.body.error ?? ''} ${grant.body.error_description ?? ''}`).toBe(200);
        accessToken = grant.body.access_token!;
        sub = String(decodeJwt(accessToken).claims['sub']).toLowerCase();
      } finally {
        await request.dispose();
      }

      runDriversSeedScript('drivers-qc938.apply.sql', { UserId: sub });
      for (const role of ROLES) {
        uuids[role] =
          queryDriversDb(
            `SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE DriverUserUUID = ${sqlText(sub)} AND Notes = N'e2e-qc938 ${role}'`,
          ) ?? '';
        expect(uuids[role], `the seeded ${role} job`).toBeTruthy();
      }
      hosts.first = queryDriversDb(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = ${sqlText(FIRST_HOST)}`) ?? '';
      hosts.second = queryDriversDb(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = N'E2E QC-938 Second Host'`) ?? '';
      today = queryDriversDb(`SELECT CONVERT(nvarchar(10), AssignmentDate, 23) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuids.offer}'`) ?? '';
      expect(hosts.first && hosts.second && today, 'the two throwaway hosts and the seeded day').toBeTruthy();
    });

    test.afterAll(() => {
      if (!sub && throwawaySubs() === 'none') return;
      const removed = removeAll([sub, throwawaySubs()].filter((id) => id && id !== 'none').join(',') || 'none');
      expect(removed, 'drivers-qc938.remove.sql leaves nothing').toContain('REMOVED left=0');
      expect(leftInDrivers(), 'no e2e-qc938 job or E2E QC-938 host is left in DRIVERS').toBe('0|0');
      expect(throwawaySubs(), 'no e2e.qc938 Identity user is left').toBe('none');
    });

    test('JOBCARD-01 a pending offer and an accepted job come back with VendorName, truckNumber and HostName on GET /sync, my-assignments and the details, equal to the as-hauled values', async ({
      driverSettingsApi,
    }) => {
      for (const role of ['offer', 'accepted'] as const) {
        const got = await sources(driverSettingsApi, role);
        for (const [source, fields] of Object.entries(got)) {
          expect(fields, `${role} on ${source}`).toEqual(expected(role));
          expect(blank(fields!.VendorName) || blank(fields!.truckNumber) || blank(fields!.HostName), `${role} on ${source}: every header field is set`).toBe(
            false,
          );
        }
      }
      const sync = await driverSettingsApi.syncAssignments(accessToken);
      const status = (role: Role) =>
        (sync.body.data?.assignments.find((a) => a.orderAssignmentUuid.toLowerCase() === uuids[role]) as unknown as { status: string } | undefined)?.status;
      expect({ offer: status('offer'), accepted: status('accepted') }, 'one pending offer and one accepted job').toEqual({
        offer: 'pending',
        accepted: 'accepted',
      });
    });

    test('JOBCARD-02 two jobs on the same day for the same Vendor and Truck from two linked Hosts carry different HostNames and HostUUIDs on every source', async ({
      driverSettingsApi,
    }) => {
      const first = await sources(driverSettingsApi, 'accepted');
      const second = await sources(driverSettingsApi, 'second host');
      for (const source of ['sync', 'list', 'details'] as const) {
        expect(second[source], `second host on ${source}`).toEqual(expected('second host'));
        expect(
          { VendorName: second[source]!.VendorName, truckNumber: second[source]!.truckNumber },
          `${source}: the first line is the same for both jobs`,
        ).toEqual({ VendorName: first[source]!.VendorName, truckNumber: first[source]!.truckNumber });
        expect(second[source]!.HostName, `${source}: Booked by tells the two jobs apart`).not.toBe(first[source]!.HostName);
        expect(second[source]!.HostUUID).not.toBe(first[source]!.HostUUID);
      }
      const list = await driverSettingsApi.myAssignments(accessToken, today);
      const sameDay = (list.body.data?.data ?? []).filter((a) => [uuids.accepted, uuids['second host']].includes(a.orderAssignmentUuid.toLowerCase()));
      expect(
        new Set(sameDay.map((a) => (a as unknown as { assignmentDate: string }).assignmentDate)),
        'one my-assignments list for the day holds both',
      ).toEqual(new Set([today]));
      expect(sameDay).toHaveLength(2);
    });

    test('JOBCARD-03 an older job with no VendorName answers 200 with VendorName empty and HostName set from the Host, on every source', async ({
      driverSettingsApi,
    }) => {
      const got = await sources(driverSettingsApi, 'no vendor');
      for (const [source, fields] of Object.entries(got)) {
        expect(fields, `no vendor on ${source}`).toBeDefined();
        expect(blank(fields!.VendorName), `${source}: VendorName is null or empty`).toBe(true);
        expect(fields!.HostName, `${source}: HostName falls back to the Host's name`).toBe(FIRST_HOST);
        expect(fields!.HostUUID).toBe(hosts.first);
      }
    });

    test('JOBCARD-04 a job with no TruckNumber answers VendorName set and truckNumber empty (no TruckName fallback) on every source', async ({
      driverSettingsApi,
    }) => {
      const got = await sources(driverSettingsApi, 'no truck');
      for (const [source, fields] of Object.entries(got)) {
        expect(fields, `no truck on ${source}`).toBeDefined();
        expect(fields!.VendorName, `${source}: VendorName`).toBe(VENDOR);
        expect(blank(fields!.truckNumber), `${source}: truckNumber is null or empty, not the TruckName`).toBe(true);
        expect(fields!.HostName, `${source}: HostName`).toBe(FIRST_AS_HAULED);
      }
    });
  },
);
