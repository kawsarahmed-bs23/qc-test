// QC-922 (D54, D99, D101): the Host's truck number lives in app.TruckSettings.TruckNumber (with VendorID_FK) instead of the
// Truck organisation's OrganisationShortName. It is optional on both Truck forms and unique within the Vendor, not the Host.
// Local only, against a host API and database with the QC-922 migration (202611121200). Throwaway data: seed/host-qc922.apply.sql
// (two vendors, a Seed Truck whose number differs from its short name, and host-only Vendor and Driver users that sign in through
// the host API with the password of APP_ADMIN_EMAIL); seed/host-qc922.remove.sql and seed/drivers-qc922.remove.sql remove it
// and everything the cases make. TNUM-08 changes the TruckSettings number of the linked driver's real truck and puts it back.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, driversColumns, queryDriversDb, querySingleValue, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { DispatchContactApi } from '@api/dispatch-contact.api';
import { NO_TRUCK_NUMBER, TRUCK_NUMBER_TAKEN, VendorPortalTrucks, fieldErrors, generatedShortName } from '@pages/truck-number.page';

const MARKER = 'e2e-qc922';
const VENDOR_A = 'E2E QC-922 Vendor A';
const VENDOR_B = 'E2E QC-922 Vendor B';
const SEED_TRUCK = 'E2E QC-922 Seed Truck';
const SEED_NUMBER = 'E2E922-SEED';
const SEED_SHORT_NAME = 'E2E922SH';
const DRIVER_NAME = 'E2E QC-922 Driver';
const VENDOR_USER = 'e2e.qc922.vendor@quarryconnect.test';
const JOB_ORDER_ID = 26;
const ORG_CACHE = { timeout: 150_000, intervals: [5_000] };
const QUEUE = { timeout: 30_000, intervals: [500, 1_000, 2_000] };

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`;
}

function value(query: string): string | null {
  return querySingleValue(query);
}

function orgId(name: string): number {
  return Number(value(`SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = ${sqlText(name)}`) ?? '0');
}

/** `<TruckNumber>|<VendorID_FK>|<OrganisationShortName>|<ParentOrganisationIdFk>` of one truck. */
function truckRow(truckId: number): string | null {
  return value(
    `SELECT CONCAT(ISNULL(ts.TruckNumber, 'NULL'), '|', ISNULL(CAST(ts.VendorID_FK AS varchar(12)), 'NULL'), '|', o.OrganisationShortName, '|', o.ParentOrganisationIdFk)
     FROM auth.Organisations o LEFT JOIN app.TruckSettings ts ON ts.OrganisationID_FK = o.OrganisationID WHERE o.OrganisationID = ${truckId}`,
  );
}

function hostToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
}

/** The host's today when it falls inside the order's date range, otherwise the range day nearest to it (the API refuses others). */
function orderDay(): string {
  return (
    value(
      `SELECT CONVERT(varchar(10), CASE WHEN '${hostToday()}' < OrderStartDate THEN OrderStartDate WHEN '${hostToday()}' > OrderEndDate THEN OrderEndDate ELSE '${hostToday()}' END, 23)
       FROM app.Orders WHERE OrderID = ${JOB_ORDER_ID}`,
    ) ?? hostToday()
  );
}

function queuesDrained(): boolean {
  return (
    value(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === '0' &&
    queryDriversDb(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === '0' &&
    queryDriversDb(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === '0'
  );
}

function removeAll(): void {
  if (canUseDriversDb()) runDriversSeedScript('drivers-qc922.remove.sql');
  const output = runSeedScript('host-qc922.remove.sql');
  if (!/REMOVED left=0/.test(output)) throw new Error(`QC-922 rows are left behind:\n${output}`);
}

test.describe('Truck number in app.TruckSettings, optional and unique within the Vendor (QC-922)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(!canSeedLocalDb(), "Needs the host's local database (local only).");
  test.skip(!env.appAdmin || !env.appApiUrl || !env.appUrl, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD, APP_URL and APP_API_URL.');
  test.skip(
    canSeedLocalDb() && value(`SELECT CASE WHEN COL_LENGTH(N'app.TruckSettings', N'TruckNumber') IS NULL THEN 0 ELSE 1 END`) !== '1',
    'The QC-922 migration (app.TruckSettings.TruckNumber) is not applied.',
  );

  let vendorA = 0;
  let vendorB = 0;
  let seedTruck = 0;
  const made: Record<'hostWithNumber' | 'hostWithout' | 'hostOtherVendor' | 'portal', number> = {
    hostWithNumber: 0,
    hostWithout: 0,
    hostOtherVendor: 0,
    portal: 0,
  };

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(240_000);
    removeAll();
    runSeedScript('host-qc922.apply.sql', { SourceEmail: env.appAdmin!.email });
    vendorA = orgId(VENDOR_A);
    vendorB = orgId(VENDOR_B);
    seedTruck = orgId(SEED_TRUCK);
    expect(vendorA * vendorB * seedTruck, 'the throwaway vendors and truck exist').toBeGreaterThan(0);

    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const admin = new DispatchContactApi(context);
      await admin.signIn(env.appAdmin!.email, env.appAdmin!.password);
      await expect
        .poll(async () => [(await admin.vendorEdit(vendorA)).status, (await admin.vendorEdit(vendorB)).status, (await admin.truckEdit(seedTruck)).status], {
          message: 'the host API sees the new organisations once its organisation tree cache (Auth:OrganisationTreeCacheSeconds) expires',
          ...ORG_CACHE,
        })
        .toEqual([200, 200, 200]);
    } finally {
      await context.dispose();
    }
  });

  test.afterAll(async () => {
    if (canUseDriversDb()) {
      for (let wait = 0; wait < 40 && !queuesDrained(); wait++) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    removeAll();
  });

  test('TNUM-01 the migration gave every Truck a TruckSettings row with its Vendor and its old short name as the number, and added the filtered unique index', () => {
    const trucks = `FROM auth.Organisations o JOIN auth.RoleTypes r ON r.RoleTypeId = o.RoleTypeIdFk AND r.RoleType = N'Truck'
      LEFT JOIN app.TruckSettings ts ON ts.OrganisationID_FK = o.OrganisationID WHERE o.OrganisationName NOT LIKE N'E2E %'`;
    expect(Number(value(`SELECT COUNT(*) ${trucks}`)), 'trucks to check').toBeGreaterThan(0);
    expect(value(`SELECT COUNT(*) ${trucks} AND ts.TruckSettingID IS NULL`), 'trucks without a TruckSettings row').toBe('0');
    expect(
      value(`SELECT COUNT(*) ${trucks} AND ISNULL(ts.VendorID_FK, -1) <> ISNULL(o.ParentOrganisationIdFk, -1)`),
      'VendorID_FK <> ParentOrganisationIdFk',
    ).toBe('0');
    expect(
      value(
        `SELECT STRING_AGG(CONCAT(o.OrganisationID, ':', o.OrganisationShortName, '->', ISNULL(ts.TruckNumber, 'NULL')), ', ') ${trucks}
         AND ISNULL(ts.TruckNumber, N'') <> ISNULL(NULLIF(LTRIM(RTRIM(o.OrganisationShortName)), N''), N'')
         AND NOT (ts.TruckNumber IS NULL AND EXISTS (SELECT 1 FROM app.TruckSettings x WHERE x.VendorID_FK = ts.VendorID_FK AND x.TruckNumber = LTRIM(RTRIM(o.OrganisationShortName))))`,
      ),
      'trucks whose number is not their old short name (a duplicate within the Vendor may stay empty)',
    ).toBeNull();
    expect(
      value(
        `SELECT CONCAT(i.is_unique, '|', i.has_filter, '|', i.filter_definition, '|', STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY ic.key_ordinal))
         FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = OBJECT_ID(N'app.TruckSettings') AND i.name = N'UX_TruckSettings_VendorID_FK_TruckNumber'
         GROUP BY i.is_unique, i.has_filter, i.filter_definition`,
      ),
    ).toBe('1|1|([TruckNumber] IS NOT NULL)|VendorID_FK,TruckNumber');
    expect(
      value(
        `SELECT CONCAT(DATA_TYPE, '(', CHARACTER_MAXIMUM_LENGTH, ')', IS_NULLABLE) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = 'app' AND TABLE_NAME = 'TruckSettings' AND COLUMN_NAME = 'TruckNumber'`,
      ),
    ).toBe('nvarchar(20)YES');
  });

  test('TNUM-02 Manage Trucks Create with a number saves it to TruckSettings with the Vendor, generates the short name from the name, and the list shows the number', async ({
    hostTruckFormPage,
    hostTrucksListPage,
  }) => {
    const name = 'E2E QC-922 Host Alpha';
    await hostTruckFormPage.open();
    await hostTruckFormPage.expectTruckNumberIsOptional();
    await hostTruckFormPage.fill({ vendor: VENDOR_A, name, number: 'E2E922-H1' });
    const saved = await hostTruckFormPage.submit();
    expect(saved.status, saved.text).toBe(201);
    await hostTruckFormPage.toasts.expectSuccess('Truck created successfully!');
    made.hostWithNumber = orgId(name);
    expect(made.hostWithNumber).toBeGreaterThan(0);
    expect(truckRow(made.hostWithNumber)).toBe(`E2E922-H1|${vendorA}|${generatedShortName(name)}|${vendorA}`);

    await hostTrucksListPage.open(name);
    await expect(hostTrucksListPage.numberHeader).toHaveText(/Truck Number/);
    await hostTrucksListPage.expectNumber(made.hostWithNumber, 'E2E922-H1');
  });

  test('TNUM-03 Manage Trucks Create without a number is allowed, stores no number, and the list shows "--"', async ({
    hostTruckFormPage,
    hostTrucksListPage,
  }) => {
    const name = 'E2E QC-922 Host Blank';
    await hostTruckFormPage.open();
    await hostTruckFormPage.fill({ vendor: VENDOR_A, name });
    await expect(hostTruckFormPage.truckNumber).toHaveValue('');
    const saved = await hostTruckFormPage.submit();
    expect(saved.status, saved.text).toBe(201);
    made.hostWithout = orgId(name);
    expect(truckRow(made.hostWithout)).toBe(`NULL|${vendorA}|${generatedShortName(name)}|${vendorA}`);

    await hostTrucksListPage.open(name);
    await hostTrucksListPage.expectNumber(made.hostWithout, NO_TRUCK_NUMBER);
  });

  test('TNUM-04 a number another truck of the same Vendor has is refused whatever its case, and the same number on a truck of another Vendor saves', async ({
    hostTruckFormPage,
  }) => {
    expect(made.hostWithNumber, 'TNUM-02 created a numbered truck').toBeGreaterThan(0);
    const refusedName = 'E2E QC-922 Host Duplicate';
    await hostTruckFormPage.open();
    await hostTruckFormPage.fill({ vendor: VENDOR_A, name: refusedName, number: 'e2e922-h1' });
    const refused = await hostTruckFormPage.submit();
    expect(refused.status, refused.text).toBe(400);
    expect(fieldErrors(refused, 'TruckNumber')).toEqual([TRUCK_NUMBER_TAKEN]);
    await expect(hostTruckFormPage.truckNumberError).toHaveText(TRUCK_NUMBER_TAKEN);
    expect(orgId(refusedName), 'no truck was created').toBe(0);

    const otherName = 'E2E QC-922 Host Bravo';
    await hostTruckFormPage.open();
    await hostTruckFormPage.fill({ vendor: VENDOR_B, name: otherName, number: 'E2E922-H1' });
    const saved = await hostTruckFormPage.submit();
    expect(saved.status, saved.text).toBe(201);
    made.hostOtherVendor = orgId(otherName);
    expect(truckRow(made.hostOtherVendor)).toBe(`E2E922-H1|${vendorB}|${generatedShortName(otherName)}|${vendorB}`);
  });

  test('TNUM-05 Edit changes the number, and moving a truck to another Vendor moves VendorID_FK with it', async ({ hostTruckFormPage, hostTrucksListPage }) => {
    expect(made.hostWithout, 'TNUM-03 created a truck').toBeGreaterThan(0);
    await hostTruckFormPage.open(made.hostWithout);
    await expect(hostTruckFormPage.truckNumber).toHaveValue('');
    await hostTruckFormPage.truckNumber.fill('E2E922-H2');
    const numbered = await hostTruckFormPage.submit();
    expect(numbered.status, numbered.text).toBe(200);
    await hostTruckFormPage.toasts.expectSuccess('Truck updated successfully!');
    expect(truckRow(made.hostWithout)).toBe(`E2E922-H2|${vendorA}|${generatedShortName('E2E QC-922 Host Blank')}|${vendorA}`);

    await hostTruckFormPage.open(made.hostWithout);
    await expect(hostTruckFormPage.truckNumber).toHaveValue('E2E922-H2');
    await hostTruckFormPage.chooseVendor(VENDOR_B);
    const moved = await hostTruckFormPage.submit();
    expect(moved.status, moved.text).toBe(200);
    expect(truckRow(made.hostWithout)).toBe(`E2E922-H2|${vendorB}|${generatedShortName('E2E QC-922 Host Blank')}|${vendorB}`);

    await hostTrucksListPage.open('E2E QC-922 Host Blank');
    await hostTrucksListPage.expectNumber(made.hostWithout, 'E2E922-H2');
  });

  test('TNUM-06 Vendor Portal Create/Edit Truck: the number is optional, saved to TruckSettings with the Vendor, a duplicate in the Vendor is refused, and the list shows "--" without one', async ({
    browser,
  }) => {
    const portal = await VendorPortalTrucks.signIn(browser, { email: VENDOR_USER, password: env.appAdmin!.password });
    const name = 'E2E QC-922 Portal Truck';
    try {
      await portal.form.open();
      await portal.form.expectTruckNumberIsOptional();
      await portal.form.fill({ name });
      const created = await portal.form.submit();
      expect(created.status, created.text).toBe(201);
      await portal.form.toasts.expectSuccess('Truck created successfully!');
      made.portal = orgId(name);
      expect(truckRow(made.portal)).toBe(`NULL|${vendorA}|${generatedShortName(name)}|${vendorA}`);
      await portal.list.open('E2E');
      await portal.list.expectNumber(made.portal, NO_TRUCK_NUMBER);

      await portal.form.open(made.portal);
      await portal.form.truckNumber.fill(SEED_NUMBER.toLowerCase());
      const refused = await portal.form.submit();
      expect(refused.status, refused.text).toBe(400);
      expect(fieldErrors(refused, 'TruckNumber')).toEqual([TRUCK_NUMBER_TAKEN]);
      await expect(portal.form.truckNumberError, 'the message shows under Truck Number').toHaveText(TRUCK_NUMBER_TAKEN);
      expect(truckRow(made.portal), 'the refused number is not saved').toBe(`NULL|${vendorA}|${generatedShortName(name)}|${vendorA}`);

      await portal.form.open(made.portal);
      await portal.form.truckNumber.fill('  E2E922-P1  ');
      const edited = await portal.form.submit();
      expect(edited.status, edited.text).toBe(200);
      await portal.form.toasts.expectSuccess('Truck updated successfully!');
      expect(truckRow(made.portal), 'saved trimmed').toBe(`E2E922-P1|${vendorA}|${generatedShortName(name)}|${vendorA}`);
      await portal.list.open('E2E');
      await portal.list.expectNumber(made.portal, 'E2E922-P1');
      await portal.list.expectNumber(seedTruck, SEED_NUMBER);
    } finally {
      await portal.close();
    }
  });

  test('TNUM-07 the Assign Truck options and a driver row on the Schedule board show the TruckSettings number (#<number>), not the short name', async ({
    hostAssignmentsApi,
    truckNumberSchedulePage,
  }) => {
    const driverId = value(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'e2e.qc922.driver@quarryconnect.test')`)!;
    test.skip(value(`SELECT COUNT(*) FROM app.Orders WHERE OrderID = ${JOB_ORDER_ID}`) !== '1', `Needs order ${JOB_ORDER_ID} of the local copy.`);
    const assignments = hostAssignmentsApi;
    expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    const created = await assignments.create({
      orderId: JOB_ORDER_ID,
      assignmentDate: orderDay(),
      vendorId: vendorA,
      truckId: seedTruck,
      driverUserId: driverId,
      truckCount: null,
      loadsAssigned: 1,
      notes: `${MARKER} board`,
    });
    expect(created.status, created.text).toBe(201);

    await truckNumberSchedulePage.open(orderDay());
    await expect(truckNumberSchedulePage.rowLabel(`#${SEED_NUMBER} · ${DRIVER_NAME}`)).toHaveCount(1);
    await expect(truckNumberSchedulePage.rowLabel(SEED_SHORT_NAME)).toHaveCount(0);

    await truckNumberSchedulePage.openAssignDialog();
    const options = await truckNumberSchedulePage.truckOptionsOf(VENDOR_A);
    await expect(options.filter({ hasText: `#${SEED_NUMBER} – ${DRIVER_NAME}` })).toHaveCount(1);
    await expect(options.filter({ hasText: SEED_SHORT_NAME })).toHaveCount(0);
  });

  test('TNUM-08 JobOffered carries the TruckSettings number: assigning a linked driver on a truck makes DRIVERS app.OrderAssignments.TruckNumber that number', async ({
    hostAssignmentsApi,
  }) => {
    test.skip(!canUseDriversDb() || !env.driversApiUrl, 'Needs DRIVERS_API_URL and the DRIVERS local database.');
    test.skip(
      queryDriversDb(`SELECT CASE WHEN OBJECT_ID(N'app.DriverDeletions', N'U') IS NULL OR OBJECT_ID(N'app.DriverSettings', N'U') IS NULL THEN 0 ELSE 1 END`) !==
        '1',
      'The DRIVERS database lacks the QC-902/QC-913 tables (app.DriverSettings, app.DriverDeletions) the Drivers API reads, so its JobOffered handler fails with "Invalid object name \'app.DriverDeletions\'" and dead-letters the message.',
    );
    const columns = driversColumns();
    const linked = (
      queryDriversDb(
        `SELECT STRING_AGG(${columns.text(`l.${columns.user}`)}, ',') FROM app.DriverHostLinks l JOIN app.Hosts h ON h.${columns.hostKey} = l.${columns.host} WHERE h.Active = 1 AND l.Active = 1`,
      ) ?? ''
    )
      .split(',')
      .filter(Boolean);
    test.skip(linked.length === 0, 'No driver is linked to the host in DRIVERS.');
    const driver = value(
      `SELECT TOP 1 CONCAT(u.Id, '|', u.OrganisationIdFk, '|', o.ParentOrganisationIdFk) FROM auth.Users u
       JOIN auth.Organisations o ON o.OrganisationID = u.OrganisationIdFk JOIN auth.RoleTypes r ON r.RoleTypeId = o.RoleTypeIdFk AND r.RoleType = N'Truck'
       WHERE u.IsActive = 1 AND LOWER(CONVERT(nvarchar(36), u.UserUUID)) IN (${linked.map((uuid) => sqlText(uuid.toLowerCase())).join(',')})
       ORDER BY u.Id`,
    );
    test.skip(!driver, 'No host driver on a truck is linked to the host in DRIVERS.');
    const [driverId, truckIdText, vendorIdText] = driver!.split('|');
    const truckId = Number(truckIdText);
    const original = value(`SELECT ISNULL(TruckNumber, N'<null>') FROM app.TruckSettings WHERE OrganisationID_FK = ${truckId}`);
    expect(original, `truck ${truckId} has a TruckSettings row`).not.toBeNull();
    const probe = 'E2E922-JOB';

    const assignments = hostAssignmentsApi;
    expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    try {
      value(`UPDATE app.TruckSettings SET TruckNumber = ${sqlText(probe)} WHERE OrganisationID_FK = ${truckId}`);
      const created = await assignments.create({
        orderId: JOB_ORDER_ID,
        assignmentDate: orderDay(),
        vendorId: Number(vendorIdText),
        truckId,
        driverUserId: driverId,
        truckCount: null,
        loadsAssigned: 1,
        notes: `${MARKER} job`,
      });
      expect(created.status, created.text).toBe(201);
      const uuid = value(
        `SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${Number(created.data)}`,
      );
      await expect
        .poll(() => queryDriversDb(`SELECT TruckNumber FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`), {
          message: 'JobOffered reaches DRIVERS with the TruckSettings number',
          ...QUEUE,
        })
        .toBe(probe);
      expect(value(`SELECT OrganisationShortName FROM auth.Organisations WHERE OrganisationID = ${truckId}`), 'the short name is not what was sent').not.toBe(
        probe,
      );
    } finally {
      value(`UPDATE app.TruckSettings SET TruckNumber = ${original === '<null>' ? 'NULL' : sqlText(original)} WHERE OrganisationID_FK = ${truckId}`);
    }
    expect(value(`SELECT ISNULL(TruckNumber, N'<null>') FROM app.TruckSettings WHERE OrganisationID_FK = ${truckId}`), 'the truck number is back').toBe(
      original,
    );
  });

  test('TNUM-09 DriverInviteAccepted fills a blank DRIVERS DriverSettings.TruckNumber from the Host truck number and never overwrites one the driver set', () => {
    test.skip(!canUseDriversDb(), 'Needs the DRIVERS local database.');
    test.skip(
      queryDriversDb(`SELECT CASE WHEN OBJECT_ID(N'app.DriverSettings', N'U') IS NULL OR OBJECT_ID(N'auth.Users', N'U') IS NULL THEN 0 ELSE 1 END`) !== '1',
      'The DRIVERS database has no app.DriverSettings / auth.Users (the QC-902 migrations are not applied), so the Drivers API has nowhere to seed the number.',
    );
    test.skip(
      true,
      "DriverInviteAccepted is only sent when a Host invite is accepted on Identity's invite pages (UINV-09 drives that with an SMTP sink and a new Identity login); this spec does not write Identity, so the seeding is covered by UINV-09's run and the Drivers API unit tests.",
    );
  });

  test('TNUM-10 the move warning on Edit Vendor names the truck of a Truck user by its TruckSettings number, and Cancel sends nothing', async ({
    dispatchContactApi,
    editVendorDispatchPage,
  }) => {
    const driverId = value(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'e2e.qc922.driver@quarryconnect.test')`)!;
    await dispatchContactApi.signIn(env.appAdmin!.email, env.appAdmin!.password);
    const organisations = ((await dispatchContactApi.vendorEdit(vendorA)).data?.availableUserOrganisations ?? []) as Record<string, unknown>[];
    expect(organisations.find((o) => o.userId === driverId)).toMatchObject({ organisationId: seedTruck, truckNumber: SEED_NUMBER, organisationType: 'Truck' });

    await editVendorDispatchPage.open(vendorA);
    await editVendorDispatchPage.addAssociatedUser(DRIVER_NAME);
    await editVendorDispatchPage.fillAddressIfEmpty('E2E QC-922 Yard', '922 Congress Ave');
    const saves = editVendorDispatchPage.countSaves();
    await editVendorDispatchPage.save.click();
    await editVendorDispatchPage.moveDialog.expectMove(
      'Vendor',
      `${DRIVER_NAME} is on Truck ${SEED_NUMBER}. Adding them to this Vendor removes them from that Truck.`,
    );
    await editVendorDispatchPage.moveDialog.cancel.click();
    await expect(editVendorDispatchPage.moveDialog.root).toHaveCount(0);
    expect(saves(), 'Cancel sends no vendor-edit POST').toBe(0);
    expect(value(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = N'${driverId}'`), 'the driver stays on the Seed Truck').toBe(String(seedTruck));
  });
});
