import { randomUUID } from 'crypto';
import type { APIRequestContext, Browser } from '@playwright/test';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { canSeedLocalDb, canUseIdentityDb, queryIdentityDb, querySingleValue, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import { HostAccountApi, hostUserId, identityAccessToken } from '@api/host-account.api';
import type { AssignmentSave, HostAssignmentsApi } from '@api/host-assignments.api';
import { env, type Credentials } from '@config/env.config';

const DISPATCHER_EMAIL = 'e2e.qc898.dispatcher@quarryconnect.test';
const DRIVER1_EMAIL = 'e2e.qc898.driver1@quarryconnect.test';
const DRIVER2_EMAIL = 'e2e.qc898.driver2@quarryconnect.test';
const MARKER = 'e2e-qc898';

interface IdentityUser extends Credentials {
  id: string;
  sub: string;
}

interface Seeded {
  hostOrganisationId: number;
  vendorId: number;
  truck1: number;
  truck2: number;
  driver1: string;
  driver2: string;
  orderId: number;
  today: string;
  tomorrow: string;
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hostValue(query: string): string | null {
  return querySingleValue(query);
}

function hostNumber(query: string): number {
  return Number(querySingleValue(query) ?? '0');
}

function counts(query: string): number[] {
  return hostValue(query)!.split('|').map(Number);
}

function organisationUuid(organisationId: number): string {
  return hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrganisationUUID)) FROM auth.Organisations WHERE OrganisationID = ${organisationId}`)!;
}

function userUuid(userId: string): string | null {
  return hostValue(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE Id = ${sqlText(userId)}`);
}

function partyUuids(orderAssignmentId: number): { vendor: string | null; truck: string | null; driver: string | null } {
  const row = hostValue(
    `SELECT CONCAT(ISNULL(LOWER(CONVERT(nvarchar(36), VendorUUID)), 'null'), '|', ISNULL(LOWER(CONVERT(nvarchar(36), TruckUUID)), 'null'), '|', ISNULL(LOWER(CONVERT(nvarchar(36), DriverUserUUID)), 'null')) FROM app.OrderAssignments WHERE OrderAssignmentID = ${orderAssignmentId}`,
  );
  expect(row, `assignment ${orderAssignmentId} exists`).not.toBeNull();
  const [vendor, truck, driver] = row!.split('|').map((value) => (value === 'null' ? null : value));
  return { vendor, truck, driver };
}

function assignmentIdByNotes(notes: string): number {
  return hostNumber(`SELECT MAX(OrderAssignmentID) FROM app.OrderAssignments WHERE Notes = ${sqlText(notes)} AND Active = 1`);
}

function hostRowsByEmail(email: string): { id: string; userUuid: string | null; organisationId: number; roles: string }[] {
  const rows = hostValue(
    `SELECT CONCAT(u.Id, '|', ISNULL(LOWER(CONVERT(nvarchar(36), u.UserUUID)), 'null'), '|', u.OrganisationIdFk, '|', ISNULL((SELECT STRING_AGG(RoleName, ',') FROM auth.UserToRoles r WHERE r.UserId = u.Id), '')) FROM auth.Users u WHERE u.NormalizedEmail = UPPER(${sqlText(email)})`,
  );
  return (rows ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, uuid, organisationId, roles] = line.split('|');
      return { id: id.toLowerCase(), userUuid: uuid === 'null' ? null : uuid, organisationId: Number(organisationId), roles };
    });
}

function seedIdentityUser(name: string, sameUuid: boolean): IdentityUser {
  const email = `e2e.qc898.${name}@quarryconnect.test`;
  runIdentitySeedScript('identity-qc898-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin!.email,
    LastName: `QC-898 ${name}`,
    SameUuid: sameUuid ? '1' : '0',
  });
  const row = queryIdentityDb(
    `SELECT CONCAT(LOWER(Id), '|', LOWER(CONVERT(nvarchar(36), UserUUID))) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`,
  );
  expect(row, `the throwaway Identity user ${email} exists`).not.toBeNull();
  const [id, sub] = row!.split('|');
  return { email, password: env.admin!.password, id, sub };
}

function seedHostUser(email: string, options: { userId: string; userUuid: string | null; organisationId: number; withAssignment?: boolean }): string {
  runSeedScript('host-qc898-user.apply.sql', {
    Email: email,
    UserId: options.userId,
    UserUuid: options.userUuid ?? 'none',
    RoleName: 'Driver',
    OrganisationId: String(options.organisationId),
    WithAssignment: options.withAssignment ? '1' : '0',
  });
  const id = hostValue(`SELECT LOWER(Id) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`);
  expect(id, `the host user ${email} exists`).not.toBeNull();
  return id!;
}

function identitySubs(): string {
  return (
    (queryIdentityDb(
      `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), UserUUID)), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC898.%@QUARRYCONNECT.TEST'`,
    ) ??
      'none') ||
    'none'
  );
}

function removeAll(subs: string): void {
  runSeedScript('host-qc898.remove.sql', { UserIds: subs });
  runIdentitySeedScript('identity-qc898.remove.sql');
}

async function exchangeFor(browser: Browser, request: APIRequestContext, user: Credentials): Promise<{ status: number; userId: string | null }> {
  const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
  try {
    const page = await context.newPage();
    const identityToken = await identityAccessToken(page, request, user);
    const exchange = await new HostAccountApi(request).identityExchange(identityToken);
    return { status: exchange.status, userId: exchange.status === 200 ? hostUserId(exchange.data!).toLowerCase() : null };
  } finally {
    await context.close();
  }
}

test.describe('Host UUIDs for users, organisations, jobs, orders and assignment parties (QC-898)', { tag: ['@regression'] }, () => {
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's and Identity's local databases (local only).");

  test('HUUID-01 every host user has a distinct UserUUID equal to its Identity UserUUID, and every organisation, job and order a distinct UUID', async () => {
    const identityDb = env.identitySql!.database;
    const [users, withUuid, distinctUuids] = counts(
      `SELECT CONCAT(COUNT(*), '|', COUNT(UserUUID), '|', COUNT(DISTINCT UserUUID)) FROM auth.Users WHERE NormalizedEmail NOT LIKE N'E2E.%'`,
    );
    expect(users).toBeGreaterThan(0);
    expect(withUuid, 'no real host user without a UserUUID').toBe(users);
    expect(distinctUuids).toBe(users);
    expect(
      hostNumber(
        `SELECT COUNT(*) FROM auth.Users h LEFT JOIN [${identityDb}].auth.Users i ON i.NormalizedEmail = h.NormalizedEmail WHERE h.NormalizedEmail NOT LIKE N'E2E.%' AND (i.Id IS NULL OR h.UserUUID IS NULL OR h.UserUUID <> i.UserUUID)`,
      ),
      'host users whose UserUUID is not the Identity UserUUID of the same email',
    ).toBe(0);
    expect(
      hostValue(
        `SELECT CONCAT(CAST(i.is_unique AS int), '|', CAST(i.has_filter AS int)) FROM sys.indexes i WHERE i.object_id = OBJECT_ID('auth.Users') AND i.name = 'UX_Users_UserUUID'`,
      ),
      'UX_Users_UserUUID is a filtered unique index',
    ).toBe('1|1');

    for (const [table, column] of [
      ['auth.Organisations', 'OrganisationUUID'],
      ['app.Jobs', 'JobUUID'],
      ['app.Orders', 'OrderUUID'],
    ]) {
      expect(
        hostValue(`SELECT CONCAT(TYPE_NAME(system_type_id), '|', is_nullable) FROM sys.columns WHERE object_id = OBJECT_ID('${table}') AND name = '${column}'`),
        `${table}.${column} is a not-null uniqueidentifier`,
      ).toBe('uniqueidentifier|0');
      expect(
        hostNumber(
          `SELECT COUNT(*) FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.object_id = OBJECT_ID('${table}') AND i.is_unique = 1 AND COL_NAME(ic.object_id, ic.column_id) = '${column}'`,
        ),
        `${table}.${column} has a unique index`,
      ).toBeGreaterThan(0);
      const [rows, distinct] = counts(`SELECT CONCAT(COUNT(*), '|', COUNT(DISTINCT ${column})) FROM ${table}`);
      expect(rows, `${table} has rows`).toBeGreaterThan(0);
      expect(distinct, `every ${table} row has its own ${column}`).toBe(rows);
    }
  });

  test("HUUID-02 every active assignment carries its vendor's and truck's OrganisationUUID and its linked driver's UserUUID, and NULLs where there is no truck or driver", async () => {
    const real = `a.Active = 1 AND ISNULL(a.Notes, N'') NOT LIKE N'e2e-%'`;
    expect(hostNumber(`SELECT COUNT(*) FROM app.OrderAssignments a WHERE ${real}`), 'active assignments to check').toBeGreaterThan(0);
    expect(
      hostNumber(
        `SELECT COUNT(*) FROM app.OrderAssignments a LEFT JOIN auth.Organisations o ON o.OrganisationID = a.VendorID_FK WHERE ${real} AND (a.VendorUUID IS NULL OR a.VendorUUID <> o.OrganisationUUID)`,
      ),
      'assignments whose VendorUUID is not their vendor OrganisationUUID',
    ).toBe(0);
    expect(
      hostNumber(
        `SELECT COUNT(*) FROM app.OrderAssignments a LEFT JOIN auth.Organisations o ON o.OrganisationID = a.TruckID_FK WHERE ${real} AND ((a.TruckID_FK IS NULL AND a.TruckUUID IS NOT NULL) OR (a.TruckID_FK IS NOT NULL AND (a.TruckUUID IS NULL OR a.TruckUUID <> o.OrganisationUUID)))`,
      ),
      'assignments whose TruckUUID is not their truck OrganisationUUID (or set without a truck)',
    ).toBe(0);
    expect(
      hostNumber(
        `SELECT COUNT(*) FROM app.OrderAssignments a LEFT JOIN auth.Users u ON u.Id = a.DriverUserID_FK WHERE ${real} AND ((a.DriverUserID_FK IS NULL AND a.DriverUserUUID IS NOT NULL) OR (a.DriverUserID_FK IS NOT NULL AND ((u.UserUUID IS NULL AND a.DriverUserUUID IS NOT NULL) OR (u.UserUUID IS NOT NULL AND (a.DriverUserUUID IS NULL OR a.DriverUserUUID <> u.UserUUID)))))`,
      ),
      "assignments whose DriverUserUUID is not their driver's UserUUID (or set on a vendor-only row)",
    ).toBe(0);
  });
});

test.describe('Host UUIDs are stamped on save, on sign-in and on invite accept (QC-898)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'default' });
  test.use(signedOut);
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's and Identity's local databases (local only).");
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway users copy that password.');
  test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

  let seeded: Seeded;
  const created: { truck?: number; vendorOnly?: number } = {};

  const assignment = (overrides: Partial<AssignmentSave> & Pick<AssignmentSave, 'notes'>): AssignmentSave => ({
    orderId: seeded.orderId,
    assignmentDate: seeded.today,
    vendorId: seeded.vendorId,
    truckId: null,
    driverUserId: null,
    truckCount: null,
    loadsAssigned: 2,
    ...overrides,
  });

  const dispatcher = async (api: HostAssignmentsApi): Promise<void> => {
    expect(await api.signIn(DISPATCHER_EMAIL, env.admin!.password), 'the throwaway dispatcher signs in to the host API').toBe(200);
  };

  test.beforeAll(() => {
    removeAll(identitySubs());
    runSeedScript('host-qc898.apply.sql', { SourceEmail: env.admin!.email, IdentityDb: env.identitySql!.database });
    const vendorId = hostNumber(`SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E QC-898 Vendor' AND UpdatedBy = 'e2e-qc898'`);
    const truck = (n: number) =>
      hostNumber(`SELECT OrganisationID FROM auth.Organisations WHERE ParentOrganisationIdFk = ${vendorId} AND OrganisationName = N'E2E QC-898 Truck ${n}'`);
    const order = hostValue(
      `SELECT TOP 1 CONCAT(OrderID, '|', CONVERT(char(10), OrderStartDate, 23), '|', CONVERT(char(10), DATEADD(DAY, 1, OrderStartDate), 23)) FROM app.Orders WHERE Notes = N'${MARKER}' ORDER BY OrderID DESC`,
    );
    expect(order, 'the e2e-qc898 order exists').not.toBeNull();
    const [orderId, today, tomorrow] = order!.split('|');
    seeded = {
      hostOrganisationId: hostNumber(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'`),
      vendorId,
      truck1: truck(1),
      truck2: truck(2),
      driver1: hostValue(`SELECT LOWER(Id) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER1_EMAIL)})`)!,
      driver2: hostValue(`SELECT LOWER(Id) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER2_EMAIL)})`)!,
      orderId: Number(orderId),
      today,
      tomorrow,
    };
    expect(seeded.truck1).toBeGreaterThan(0);
    expect(seeded.truck2).toBeGreaterThan(0);
    expect(userUuid(seeded.driver1), 'driver1 is linked (UserUUID = Id)').toBe(seeded.driver1);
    expect(userUuid(seeded.driver2), 'driver2 has no UserUUID').toBeNull();
  });

  test.afterAll(async () => {
    const subs = identitySubs();
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    removeAll(subs);
    expect(hostNumber(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC898.%'`), 'no QC-898 host user is left').toBe(0);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE Notes = N'${MARKER}'`), 'no QC-898 order is left').toBe(0);
    expect(hostNumber(`SELECT COUNT(*) FROM auth.Organisations WHERE UpdatedBy = 'e2e-qc898'`), 'no QC-898 organisation is left').toBe(0);
    expect(Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC898.%'`)), 'no QC-898 Identity user is left').toBe(0);
  });

  test.describe('saving an assignment through the API', () => {
    test.describe.configure({ mode: 'serial' });

    test('HUUID-03 creating an assignment through POST api/order/{id}/assignment stamps VendorUUID, TruckUUID and DriverUserUUID, with NULLs on a vendor-only row', async ({
      hostAssignmentsApi,
    }) => {
      await dispatcher(hostAssignmentsApi);

      const withTruck = await hostAssignmentsApi.create(assignment({ truckId: seeded.truck1, driverUserId: seeded.driver1, notes: `${MARKER} create truck` }));
      expect(withTruck.status, withTruck.text).toBe(201);
      created.truck = assignmentIdByNotes(`${MARKER} create truck`);
      expect(created.truck).toBeGreaterThan(0);
      expect(partyUuids(created.truck)).toEqual({ vendor: organisationUuid(seeded.vendorId), truck: organisationUuid(seeded.truck1), driver: seeded.driver1 });

      const vendorOnly = await hostAssignmentsApi.create(assignment({ truckCount: 1, notes: `${MARKER} create vendor` }));
      expect(vendorOnly.status, vendorOnly.text).toBe(201);
      created.vendorOnly = assignmentIdByNotes(`${MARKER} create vendor`);
      expect(created.vendorOnly).toBeGreaterThan(0);
      expect(partyUuids(created.vendorOnly)).toEqual({ vendor: organisationUuid(seeded.vendorId), truck: null, driver: null });
    });

    test("HUUID-04 updating an assignment through PUT api/assignment/{id} stamps the new parties' UUIDs, and a driver with no UserUUID leaves DriverUserUUID NULL", async ({
      hostAssignmentsApi,
    }) => {
      test.skip(!created.truck || !created.vendorOnly, 'HUUID-03 did not create the assignments.');
      await dispatcher(hostAssignmentsApi);
      hostValue(
        `UPDATE app.OrderAssignments SET VendorUUID = NULL, TruckUUID = NULL, DriverUserUUID = NULL WHERE OrderAssignmentID = ${created.truck} AND Notes LIKE N'${MARKER} %'`,
      );

      const toUnlinkedDriver = await hostAssignmentsApi.update(
        created.truck!,
        assignment({ truckId: seeded.truck2, driverUserId: seeded.driver2, notes: `${MARKER} create truck` }),
      );
      expect(toUnlinkedDriver.status, toUnlinkedDriver.text).toBe(200);
      expect(partyUuids(created.truck!)).toEqual({ vendor: organisationUuid(seeded.vendorId), truck: organisationUuid(seeded.truck2), driver: null });

      const toLinkedDriver = await hostAssignmentsApi.update(
        created.vendorOnly!,
        assignment({ truckId: seeded.truck1, driverUserId: seeded.driver1, notes: `${MARKER} create vendor` }),
      );
      expect(toLinkedDriver.status, toLinkedDriver.text).toBe(200);
      expect(partyUuids(created.vendorOnly!)).toEqual({
        vendor: organisationUuid(seeded.vendorId),
        truck: organisationUuid(seeded.truck1),
        driver: seeded.driver1,
      });
    });

    test('HUUID-05 copying assignments through POST api/assignment/copy stamps the UUIDs on every copy', async ({ hostAssignmentsApi }) => {
      test.skip(!created.truck || !created.vendorOnly, 'HUUID-03 did not create the assignments.');
      await dispatcher(hostAssignmentsApi);

      const copied = await hostAssignmentsApi.copy(seeded.today, [created.truck!, created.vendorOnly!], [seeded.tomorrow]);
      expect(copied.status, copied.text).toBe(200);
      expect(copied.data?.created).toBe(2);
      const copies = copied.data!.createdAssignmentIds;
      expect(copies).toHaveLength(2);

      const expected = new Map([
        [`${MARKER} create truck`, { vendor: organisationUuid(seeded.vendorId), truck: organisationUuid(seeded.truck2), driver: null }],
        [`${MARKER} create vendor`, { vendor: organisationUuid(seeded.vendorId), truck: organisationUuid(seeded.truck1), driver: seeded.driver1 }],
      ]);
      for (const id of copies) {
        const row = hostValue(
          `SELECT CONCAT(ISNULL(Notes, N''), '|', CONVERT(char(10), AssignmentDate, 23)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`,
        )!;
        const [notes, date] = row.split('|');
        expect(date, `copy ${id} is on the target day`).toBe(seeded.tomorrow);
        expect(expected.has(notes), `copy ${id} keeps its source's notes (${notes})`).toBe(true);
        expect(partyUuids(id), `copy ${id} (${notes})`).toEqual(expected.get(notes));
      }
    });
  });

  test.describe('host sign-in through the identity exchange', () => {
    test.skip(!env.hostClient, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI) to get an Identity token for the identity exchange.');

    test('HUUID-06 a host user whose Id is the sub and whose UserUUID is NULL signs in and gets UserUUID = sub stamped', async ({ browser, request }) => {
      const user = seedIdentityUser('fallback', true);
      const hostId = seedHostUser(user.email, { userId: user.id, userUuid: null, organisationId: seeded.hostOrganisationId });
      expect(userUuid(hostId)).toBeNull();

      const exchange = await exchangeFor(browser, request, user);
      expect(exchange.status, 'the identity exchange signs the user in').toBe(200);
      expect(exchange.userId).toBe(hostId);
      expect(userUuid(hostId), 'the host row is stamped with the token sub').toBe(user.sub);
      expect(hostRowsByEmail(user.email)).toHaveLength(1);
    });

    test('HUUID-07 a host user found by UserUUID = sub signs in even though its Id is not the sub', async ({ browser, request }) => {
      const user = seedIdentityUser('moved', false);
      expect(user.sub).not.toBe(user.id);
      const hostId = seedHostUser(user.email, { userId: 'new', userUuid: user.sub, organisationId: seeded.hostOrganisationId });
      expect(hostId).not.toBe(user.sub);

      const exchange = await exchangeFor(browser, request, user);
      expect(exchange.status, 'the identity exchange signs the user in').toBe(200);
      expect(exchange.userId, 'the host token carries the host row Id').toBe(hostId);
      expect(userUuid(hostId)).toBe(user.sub);
    });

    test('HUUID-08 a host user whose UserUUID is another identity is refused, whether its Id is the sub or not, and is not re-stamped', async ({
      browser,
      request,
    }) => {
      const other = randomUUID();
      const stranger = seedIdentityUser('refused', false);
      const strangerHost = seedHostUser(stranger.email, { userId: stranger.id, userUuid: other, organisationId: seeded.hostOrganisationId });
      expect(strangerHost).not.toBe(stranger.sub);

      const refused = await exchangeFor(browser, request, stranger);
      expect(refused.status, 'Id and UserUUID both differ from the sub').toBe(401);
      expect(userUuid(strangerHost)).toBe(other);

      const second = randomUUID();
      const taken = seedIdentityUser('taken', true);
      const takenHost = seedHostUser(taken.email, { userId: taken.id, userUuid: second, organisationId: seeded.hostOrganisationId });
      expect(takenHost).toBe(taken.sub);

      const alsoRefused = await exchangeFor(browser, request, taken);
      expect(alsoRefused.status, 'Id = sub but UserUUID already points at another identity').toBe(401);
      expect(userUuid(takenHost), 'the stored UserUUID is kept').toBe(second);
    });
  });
});
