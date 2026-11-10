import { randomUUID } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseIdentityDb,
  queryDriversDb,
  queryIdentityDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';
import { newAuthenticatorKey } from '@utils/totp';
import { DriverBillRatesApi, HostBillRatesApi, type DriverRate, type JobRateRow } from '@api/bill-rates.api';
import { HostAssignmentsApi, type AssignmentSave } from '@api/host-assignments.api';
import { isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { BILL_RATES_HELP, BillRatesSession } from '@pages/bill-rates.page';
import { env } from '@config/env.config';

const MARKER = 'e2e-qc827';
const VENDOR_EMAIL = 'e2e.qc827.vendor@quarryconnect.test';
const DRIVER_EMAIL = 'e2e.qc827.driver@quarryconnect.test';
const ADMIN_EMAIL = 'e2e.qc827.admin@quarryconnect.test';
const QUEUE = { timeout: 30_000, intervals: [500, 1_000, 2_000] };
const CUSTOMER_SIDE = [95.25, 4.4, 6.15, 8.65, 99.1];

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hostValue(query: string): string | null {
  return querySingleValue(query);
}

function hostNumber(query: string): number {
  return Number(querySingleValue(query) ?? '0');
}

function driversValue(query: string): string | null {
  return queryDriversDb(query);
}

function driversNumber(query: string): number {
  return Number(queryDriversDb(query) ?? '0');
}

function hostToday(addDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + addDays);
  return date.toISOString().slice(0, 10);
}

function existingThrowawayUsers(): string {
  return (
    (queryIdentityDb(
      `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), UserUUID)), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC827.%@QUARRYCONNECT.TEST'`,
    ) ??
      'none') ||
    'none'
  );
}

function removeAll(userIds: string): void {
  runDriversSeedScript('drivers-qc827.remove.sql', { UserIds: userIds });
  runSeedScript('host-qc827.remove.sql');
  runIdentitySeedScript('identity-qc827.remove.sql');
}

function rateSet(uuid: string, where: string): string {
  return (
    driversValue(
      `SELECT STRING_AGG(CONCAT(Code, ':', FORMAT(Amount, '0.00'), ':', Unit, ':', CONVERT(char(10), EffectiveFrom, 23)), ',') WITHIN GROUP (ORDER BY AssignmentRateID) FROM app.AssignmentRates WHERE OrderAssignmentUUID = '${uuid}' AND ${where}`,
    ) ?? ''
  );
}

function currentRates(uuid: string): string {
  return rateSet(uuid, 'SupersededAt IS NULL AND NotAppliedReason IS NULL AND Active = 1');
}

function rateRows(uuid: string): number {
  return driversNumber(`SELECT COUNT(*) FROM app.AssignmentRates WHERE OrderAssignmentUUID = '${uuid}'`);
}

function currentChangeUuid(uuid: string): string | null {
  return driversValue(
    `SELECT LOWER(CONVERT(nvarchar(36), MAX(CONVERT(nvarchar(36), ChangeUUID)))) FROM app.AssignmentRates WHERE OrderAssignmentUUID = '${uuid}' AND SupersededAt IS NULL AND NotAppliedReason IS NULL`,
  );
}

function lastHistory(assignmentId: number, like: string): { text: string; changeUuid: string | null } | null {
  const row = hostValue(
    `SELECT TOP 1 CONCAT(OrderAssignmentHistoryData, '|', ISNULL(LOWER(CONVERT(nvarchar(36), ChangeUUID)), 'null')) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignmentId} AND OrderAssignmentHistoryData LIKE ${sqlText(like)} ORDER BY OrderAssignmentHistoryID DESC`,
  );
  if (!row) return null;
  const at = row.lastIndexOf('|');
  const changeUuid = row.slice(at + 1);
  return { text: row.slice(0, at), changeUuid: changeUuid === 'null' ? null : changeUuid };
}

function historyCount(assignmentId: number, like: string): number {
  return hostNumber(
    `SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignmentId} AND OrderAssignmentHistoryData LIKE ${sqlText(like)}`,
  );
}

function queuesDrained(): boolean {
  return (
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0
  );
}

async function waitForQueues(): Promise<void> {
  for (let wait = 0; wait < 40 && !queuesDrained(); wait++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) value.forEach((item) => numbersIn(item, found));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => numbersIn(item, found));
  return found;
}

function shape(rates: DriverRate[] | null): Record<string, unknown>[] {
  return (rates ?? []).map((r) => ({
    Code: r.Code,
    Label: r.Label,
    Amount: Number(r.Amount),
    Unit: r.Unit,
    EffectiveFrom: String(r.EffectiveFrom).slice(0, 10),
    ...(r.WasAmount !== undefined ? { WasAmount: Number(r.WasAmount) } : {}),
    ...(r.WasUnit !== undefined ? { WasUnit: r.WasUnit } : {}),
    ...(r.ChangedAt !== undefined ? { ChangedAt: 'set' } : {}),
  }));
}

function jobRates(job: Record<string, unknown>): JobRateRow[] {
  return ((job.rates ?? []) as Record<string, unknown>[]).map((rate) => ({
    jobRateId: rate.jobRateId as number,
    effectiveFrom: String(rate.effectiveFrom).slice(0, 10),
    effectiveTo: rate.effectiveTo ? String(rate.effectiveTo).slice(0, 10) : null,
    invoiceRate: Number(rate.invoiceRate),
    materialsCost: Number(rate.materialsCost),
    materialsRate: Number(rate.materialsRate),
    billRate: Number(rate.billRate),
    fuelApplies: Boolean(rate.fuelApplies),
    fuelRate: Number(rate.fuelRate),
    billFuelRate: Number(rate.billFuelRate),
  }));
}

test.describe(
  'Drivers can see Bill Rates: the Vendor switch sends the Bill side of the Job rate to the Driver (QC-827)',
  { tag: ['@write', '@regression'] },
  () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
    test.skip(
      !env.admin || !env.appAdmin,
      'Needs ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway users copy that password) and APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD.',
    );
    test.skip(!env.appApiUrl || !env.driversApiUrl || !env.appUrl, 'Needs APP_URL, APP_API_URL and DRIVERS_API_URL.');

    let hostUuid = '';
    let vendorKey = '';
    let adminKey = '';
    let vendorUserId = '';
    let driverSub = '';
    let vendorId = 0;
    let truckId = 0;
    let jobId = 0;
    let orderId = 0;
    let rateFrom = '';
    let admin: HostBillRatesApi;
    let vendor: HostBillRatesApi;
    let anonymous: HostBillRatesApi;
    let assignments: HostAssignmentsApi;
    let driver: DriverBillRatesApi;
    let deadLetters = { host: 0, drivers: 0 };
    const first = { id: 0, uuid: '' };
    const later = { id: 0, uuid: '' };

    const assignment = (overrides: Partial<AssignmentSave>): AssignmentSave => ({
      orderId,
      assignmentDate: hostToday(),
      vendorId,
      truckId,
      driverUserId: driverSub,
      truckCount: null,
      loadsAssigned: 2,
      notes: MARKER,
      ...overrides,
    });

    const offer = async (target: { id: number; uuid: string }, assignmentDate: string, role: string): Promise<void> => {
      const created = await assignments.create(assignment({ assignmentDate, notes: `${MARKER} ${role}` }));
      expect(created.status, created.text).toBe(201);
      target.id = Number(created.data);
      target.uuid = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${target.id}`)!;
      await expect
        .poll(
          () =>
            driversValue(
              `SELECT CONCAT(Status, '|', LOWER(CONVERT(nvarchar(36), DriverUserUUID))) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${target.uuid}'`,
            ),
          {
            message: 'JobOffered reaches DRIVERS',
            ...QUEUE,
          },
        )
        .toBe(`1|${driverSub}`);
    };

    const saveRates = async (change: (rates: JobRateRow[]) => JobRateRow[]): Promise<void> => {
      const job = await admin.job(jobId);
      const saved = await admin.saveJobWithRates(job, change(jobRates(job)));
      expect(saved.status(), await saved.text()).toBe(200);
    };

    const switchValue = () => hostValue(`SELECT CAST(DriversCanSeeBillRates AS int) FROM app.VendorSettings WHERE OrganisationID_FK = ${vendorId}`);

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(180_000);
      hostUuid = (
        driversValue(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = ${sqlText(env.hostName)} AND Active = 1`) ?? ''
      ).toLowerCase();
      test.skip(!hostUuid, `The host '${env.hostName}' (HOST_NAME) is not an active host in DRIVERS.`);
      test.skip(
        driversNumber(`SELECT CASE WHEN OBJECT_ID(N'app.AssignmentRates', N'U') IS NULL THEN 0 ELSE 1 END`) === 0 ||
          hostNumber(
            `SELECT CASE WHEN COL_LENGTH(N'app.VendorSettings', N'DriversCanSeeBillRates') IS NULL OR COL_LENGTH(N'app.OrderAssignmentHistory', N'ChangeUUID') IS NULL THEN 0 ELSE 1 END`,
          ) === 0,
        'The QC-827 migrations (DRIVERS 040 app.AssignmentRates; host DriversCanSeeBillRates and OrderAssignmentHistory.ChangeUUID) are not applied.',
      );

      const probe = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        test.skip(!(await isDriversApiReachable(probe)), 'The drivers API (DRIVERS_API_URL) is not running.');
      } finally {
        await probe.dispose();
      }

      removeAll(existingThrowawayUsers());

      vendorKey = newAuthenticatorKey();
      runIdentitySeedScript('identity-qc827-user.apply.sql', {
        Email: VENDOR_EMAIL,
        SourceEmail: env.admin!.email,
        LastName: 'QC-827 Vendor',
        TwoFactor: '1',
        AuthenticatorKey: vendorKey,
      });
      runIdentitySeedScript('identity-qc827-user.apply.sql', {
        Email: DRIVER_EMAIL,
        SourceEmail: env.admin!.email,
        LastName: 'QC-827 Driver',
        TwoFactor: '0',
        AuthenticatorKey: 'none',
      });
      adminKey = newAuthenticatorKey();
      runIdentitySeedScript('identity-qc827-user.apply.sql', {
        Email: ADMIN_EMAIL,
        SourceEmail: env.admin!.email,
        LastName: 'QC-827 Admin',
        TwoFactor: '1',
        AuthenticatorKey: adminKey,
      });
      const adminUserId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(ADMIN_EMAIL)})`) ?? '';
      vendorUserId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(VENDOR_EMAIL)})`) ?? '';
      driverSub = (queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER_EMAIL)})`) ?? '').toLowerCase();
      expect(vendorUserId, 'the throwaway Identity vendor exists').toMatch(/^[0-9a-f-]{36}$/);
      expect(driverSub, 'the throwaway Identity driver exists').toMatch(/^[0-9a-f-]{36}$/);

      runSeedScript('host-qc827.apply.sql', {
        VendorUserId: vendorUserId,
        VendorEmail: VENDOR_EMAIL,
        DriverUserId: driverSub,
        DriverEmail: DRIVER_EMAIL,
        AdminUserId: adminUserId,
        AdminEmail: ADMIN_EMAIL,
        IdentityDb: env.identitySql!.database,
      });
      vendorId = hostNumber(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = ${sqlText(vendorUserId)}`);
      truckId = hostNumber(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = ${sqlText(driverSub)}`);
      jobId = hostNumber(`SELECT JobID FROM app.Jobs WHERE JobNotes = N'${MARKER}'`);
      orderId = hostNumber(`SELECT OrderID FROM app.Orders WHERE JobID_FK = ${jobId}`);
      rateFrom = hostValue(`SELECT CONVERT(char(10), EffectiveFrom, 23) FROM app.JobRates WHERE JobID_FK = ${jobId}`) ?? '';
      expect(vendorId * truckId * jobId * orderId, 'the throwaway vendor, truck, job and order exist').toBeGreaterThan(0);

      runDriversSeedScript('drivers-qc827.apply.sql', { UserId: driverSub, HostUuid: hostUuid });

      const grant = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        const token = await new PasswordGrantApi(grant).passwordGrant(DRIVER_EMAIL, env.admin!.password);
        expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
        driver = new DriverBillRatesApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), token.body.access_token!);
      } finally {
        await grant.dispose();
      }

      const adminContext = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      admin = new HostBillRatesApi(adminContext);
      assignments = new HostAssignmentsApi(adminContext);
      expect(await admin.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the host admin signs in to the host API').toBe(200);
      expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
      vendor = new HostBillRatesApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }));
      expect(await vendor.signIn(VENDOR_EMAIL, env.admin!.password), 'the throwaway Vendor-role user signs in to the host API').toBe(200);
      anonymous = new HostBillRatesApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }));

      deadLetters = {
        host: hostNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
        drivers: driversNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
      };
    });

    test.afterAll(async () => {
      test.setTimeout(120_000);
      await waitForQueues();
      removeAll(driverSub || existingThrowawayUsers());
    });

    test('BRATE-01 with the switch off (default) an offer stores no rates in DRIVERS, the Drivers API shows Rates [] and the host history says none', async () => {
      expect(switchValue(), 'the new vendor starts with the switch off').toBe('0');
      test.setTimeout(150_000);
      await expect
        .poll(async () => (await admin.vendorEdit(vendorId)).status, {
          message: 'the host API sees the new vendor once its organisation tree cache (Auth:OrganisationTreeCacheSeconds, 60 s) expires',
          timeout: 90_000,
          intervals: [5_000],
        })
        .toBe(200);
      const edit = await admin.vendorEdit(vendorId);
      expect(edit.data?.driversCanSeeBillRates, 'GET vendor-edit returns driversCanSeeBillRates').toBe(false);

      await offer(first, hostToday(), 'first');
      await waitForQueues();
      expect(rateRows(first.uuid), 'no AssignmentRates rows').toBe(0);
      expect(await driver.rates(first.uuid), 'details Rates').toEqual([]);
      expect(await driver.listedRates(first.uuid, { from: hostToday(-1), to: hostToday(14) }), 'my-assignments Rates').toEqual([]);
      expect(lastHistory(first.id, 'Job offer sent%')).toEqual({
        text: 'Job offer sent to the Driver. Rates: none (Drivers can see Bill Rates is off).',
        changeUuid: null,
      });
    });

    test('BRATE-02 ticking "Drivers can see Bill Rates" on Edit Vendor and saving sets the flag and sends switch-on with the Bill freight and fuel rates to the open assignment', async ({
      browser,
    }) => {
      expect(first.uuid, 'BRATE-01 offered the first assignment').not.toBe('');
      const session = await BillRatesSession.signIn(browser, { email: ADMIN_EMAIL, password: env.admin!.password }, adminKey);
      try {
        const page = session.editVendor;
        await page.open(vendorId);
        await expect(page.billRatesHelp).toHaveText(BILL_RATES_HELP);
        await expect(page.billRatesCheckbox).not.toBeChecked();
        await page.billRatesCheckbox.check();
        await page.fillAddressIfEmpty('E2E QC-827 Yard', '827 Congress Ave');
        expect(await page.saveVendor(), 'POST vendor-edit').toBe(200);
        await expect.poll(switchValue, { message: 'VendorSettings.DriversCanSeeBillRates', ...QUEUE }).toBe('1');

        await page.open(vendorId);
        await expect(page.billRatesCheckbox, 'the saved switch shows after a reload').toBeChecked();
      } finally {
        await session.close();
      }

      const expected = `freight:72.50:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`;
      await expect.poll(() => currentRates(first.uuid), { message: 'JobRatesChanged switch-on reaches DRIVERS', ...QUEUE }).toBe(expected);
      const sent = lastHistory(first.id, 'Rates sent to the Driver (switch-on)%');
      expect(sent?.text).toMatch(
        new RegExp(
          `^Rates sent to the Driver \\(switch-on\\): Freight \\$72\\.50 / ton, Fuel Surcharge 3\\.3% \\(effective ${rateFrom}\\), Job rate \\d+, Drivers can see Bill Rates on\\.$`,
        ),
      );
      expect(sent?.changeUuid, 'the history ChangeUUID is the DRIVERS set ChangeUUID').toBe(currentChangeUuid(first.uuid));
      expect(shape(await driver.rates(first.uuid))).toEqual([
        { Code: 'freight', Label: 'Freight', Amount: 72.5, Unit: 'ton', EffectiveFrom: rateFrom },
        { Code: 'fuel-surcharge', Label: 'Fuel Surcharge', Amount: 3.3, Unit: 'percent', EffectiveFrom: rateFrom },
      ]);
    });

    test('BRATE-03 a new offer with the switch on carries only the Bill side of the rate effective on its date, never an Invoice or material amount', async () => {
      await offer(later, hostToday(5), 'later');
      const expected = `freight:72.50:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`;
      await expect.poll(() => currentRates(later.uuid), { message: 'JobOffered.Rates reach DRIVERS', ...QUEUE }).toBe(expected);
      expect(
        driversNumber(`SELECT COUNT(*) FROM app.AssignmentRates WHERE OrderAssignmentUUID = '${later.uuid}' AND Amount IN (${CUSTOMER_SIDE.join(', ')})`),
        'no Invoice, customer fuel or material amount is stored',
      ).toBe(0);
      expect(lastHistory(later.id, 'Job offer sent%')?.text).toMatch(
        new RegExp(
          `^Job offer sent to the Driver\\. Rates: Freight \\$72\\.50 / ton, Fuel Surcharge 3\\.3% \\(effective ${rateFrom}\\), Job rate \\d+, Drivers can see Bill Rates on\\.$`,
        ),
      );
      expect(lastHistory(later.id, 'Job offer sent%')?.changeUuid, 'JobOffered history has no ChangeUUID').toBeNull();

      const details = JSON.parse(await driver.detailsText(later.uuid));
      const offered = [
        { Code: 'freight', Label: 'Freight', Amount: 72.5, Unit: 'ton', EffectiveFrom: rateFrom },
        { Code: 'fuel-surcharge', Label: 'Fuel Surcharge', Amount: 3.3, Unit: 'percent', EffectiveFrom: rateFrom },
      ];
      expect(shape(details.data.Rates), 'details Rates').toEqual(offered);
      expect(
        numbersIn(details).filter((n) => CUSTOMER_SIDE.includes(n)),
        'the details response has no customer-side amount',
      ).toEqual([]);
      expect(shape(await driver.listedRates(later.uuid, { from: hostToday(-1), to: hostToday(14) })), 'my-assignments Rates').toEqual(offered);
      expect(shape(await driver.syncedRates(later.uuid)), '/sync Assignments Rates').toEqual(offered);
    });

    test('BRATE-04 a Bill rate change before Begin Haul supersedes the old set, the Drivers API shows WasAmount/WasUnit/ChangedAt, and the host history carries the same ChangeUUID', async () => {
      expect(later.uuid, 'BRATE-03 offered the later assignment').not.toBe('');
      await saveRates((rates) => rates.map((rate) => ({ ...rate, billRate: 75 })));

      const expected = `freight:75.00:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`;
      await expect.poll(() => currentRates(first.uuid), { message: 'rate-changed reaches the first assignment', ...QUEUE }).toBe(expected);
      await expect.poll(() => currentRates(later.uuid), { message: 'rate-changed reaches the later assignment', ...QUEUE }).toBe(expected);
      expect(rateSet(first.uuid, 'SupersededAt IS NOT NULL'), 'the switch-on set is superseded').toBe(
        `freight:72.50:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`,
      );

      expect(shape(await driver.rates(first.uuid))).toEqual([
        { Code: 'freight', Label: 'Freight', Amount: 75, Unit: 'ton', EffectiveFrom: rateFrom, WasAmount: 72.5, WasUnit: 'ton', ChangedAt: 'set' },
        { Code: 'fuel-surcharge', Label: 'Fuel Surcharge', Amount: 3.3, Unit: 'percent', EffectiveFrom: rateFrom },
      ]);
      const sent = lastHistory(first.id, 'Rates sent to the Driver (rate-changed)%');
      expect(sent?.text).toMatch(/^Rates sent to the Driver \(rate-changed\): Freight \$75\.00 \/ ton, Fuel Surcharge 3\.3% /);
      expect(sent?.changeUuid, 'the history ChangeUUID is the DRIVERS set ChangeUUID').toBe(currentChangeUuid(first.uuid));
      expect(lastHistory(later.id, 'Rates sent to the Driver (rate-changed)%')?.changeUuid).toBe(currentChangeUuid(later.uuid));
    });

    test('BRATE-05 a new rate effective after an assignment date sends rate-changed only to the assignments dated on or after it', async () => {
      const newFrom = hostToday(3);
      const firstHistory = historyCount(first.id, 'Rates sent to the Driver%');
      const firstRows = rateRows(first.uuid);

      await saveRates((rates) => [
        ...rates.map((rate) => ({ ...rate, effectiveTo: hostToday(2) })),
        {
          jobRateId: 0,
          effectiveFrom: newFrom,
          effectiveTo: null,
          invoiceRate: 99.1,
          materialsCost: 6.15,
          materialsRate: 8.65,
          billRate: 81,
          fuelApplies: true,
          fuelRate: 4.4,
          billFuelRate: 3.3,
        },
      ]);

      await expect
        .poll(() => currentRates(later.uuid), { message: 'the later assignment gets the new rate', ...QUEUE })
        .toBe(`freight:81.00:ton:${newFrom},fuel-surcharge:3.30:percent:${newFrom}`);
      await waitForQueues();
      expect(currentRates(first.uuid), 'the first assignment keeps its rate').toBe(`freight:75.00:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`);
      expect(historyCount(first.id, 'Rates sent to the Driver%'), 'no JobRatesChanged history for the first assignment').toBe(firstHistory);
      expect(rateRows(first.uuid), 'no new DRIVERS rows for the first assignment').toBe(firstRows);
      expect(lastHistory(later.id, 'Rates sent to the Driver (rate-changed)%')?.text).toMatch(
        new RegExp(`Freight \\$81\\.00 / ton, Fuel Surcharge 3\\.3% \\(effective ${newFrom}\\)`),
      );
    });

    test('BRATE-06 a rate change after Begin Haul is stored with NotAppliedReason haul-started and the current Rates stay as they were', async () => {
      const accepted = await driver.accept(first.uuid);
      expect(accepted.status(), await accepted.text()).toBe(202);
      expect(shape((await accepted.json()).data?.Rates), 'the accept response carries Rates').toEqual([
        { Code: 'freight', Label: 'Freight', Amount: 75, Unit: 'ton', EffectiveFrom: rateFrom, WasAmount: 72.5, WasUnit: 'ton', ChangedAt: 'set' },
        { Code: 'fuel-surcharge', Label: 'Fuel Surcharge', Amount: 3.3, Unit: 'percent', EffectiveFrom: rateFrom },
      ]);
      await expect
        .poll(() => hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${first.id}`), {
          message: 'JobAccepted',
          ...QUEUE,
        })
        .toBe(2);
      const begun = await driver.beginHaulWithTrip(first.uuid, randomUUID());
      expect(begun.status(), await begun.text()).toBe(202);
      expect(driversNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentUUID = '${first.uuid}'`), 'DRIVERS has the trip').toBe(1);
      await expect
        .poll(() => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${first.id}`), { message: 'TripStarted', ...QUEUE })
        .toBe(1);
      await waitForQueues();
      const laterHistory = historyCount(later.id, 'Rates sent to the Driver%');

      await saveRates((rates) => rates.map((rate) => (rate.effectiveFrom === rateFrom ? { ...rate, billRate: 77 } : rate)));

      await expect
        .poll(() => rateSet(first.uuid, `NotAppliedReason = 'haul-started'`), { message: 'the late JobRatesChanged is stored as not applied', ...QUEUE })
        .toBe(`freight:77.00:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`);
      expect(currentRates(first.uuid), 'the current set is unchanged').toBe(`freight:75.00:ton:${rateFrom},fuel-surcharge:3.30:percent:${rateFrom}`);
      expect(shape(await driver.rates(first.uuid))[0], 'the Drivers API still shows the rate at Begin Haul').toMatchObject({ Code: 'freight', Amount: 75 });
      const sent = lastHistory(first.id, 'Rates sent to the Driver (rate-changed)%');
      expect(sent?.text).toMatch(/Freight \$77\.00 \/ ton/);
      expect(sent?.changeUuid, 'the host history ChangeUUID is the not-applied set ChangeUUID').toBe(
        driversValue(
          `SELECT LOWER(CONVERT(nvarchar(36), MAX(CONVERT(nvarchar(36), ChangeUUID)))) FROM app.AssignmentRates WHERE OrderAssignmentUUID = '${first.uuid}' AND NotAppliedReason = 'haul-started'`,
        ),
      );
      await waitForQueues();
      expect(historyCount(later.id, 'Rates sent to the Driver%'), 'the later assignment (on the new rate) gets nothing').toBe(laterHistory);
    });

    test('BRATE-07 a Vendor-role user unticking the switch on My Profile saves it at once and sends switch-off, so the Drivers API shows Rates []', async ({
      browser,
    }) => {
      expect(switchValue(), 'BRATE-02 switched it on').toBe('1');
      const session = await BillRatesSession.signIn(browser, { email: VENDOR_EMAIL, password: env.admin!.password }, vendorKey);
      try {
        const profile = session.profile;
        await profile.open();
        await expect(profile.help).toHaveText(BILL_RATES_HELP);
        await expect(profile.checkbox).toBeChecked();
        expect(await profile.toggle(), 'POST api/vendor/settings/bill-rates').toBe(200);
        await expect(profile.savedNotice).toBeVisible();
        await expect(profile.checkbox).not.toBeChecked();
        await expect.poll(switchValue, { message: 'VendorSettings.DriversCanSeeBillRates', ...QUEUE }).toBe('0');

        await profile.open();
        await expect(profile.checkbox, 'the saved switch shows after a reload').not.toBeChecked();
      } finally {
        await session.close();
      }

      await expect.poll(() => currentRates(later.uuid), { message: 'switch-off empties the later assignment', ...QUEUE }).toBe('');
      expect(await driver.rates(later.uuid), 'details Rates').toEqual([]);
      const sent = lastHistory(later.id, 'Rates sent to the Driver (switch-off)%');
      expect(sent?.text).toBe('Rates sent to the Driver (switch-off): none (Drivers can see Bill Rates is off).');
      expect(sent?.changeUuid, 'switch-off history has a ChangeUUID').toMatch(/^[0-9a-f-]{36}$/);
    });

    test('BRATE-08 the Vendor Portal bill-rates endpoint answers 401 signed out and 403 to a non-Vendor user, and only a Vendor-role user reads it', async () => {
      expect((await anonymous.billRatesSetting(true)).status, 'GET signed out').toBe(401);
      expect((await anonymous.saveBillRatesSetting(true, true)).status, 'POST signed out').toBe(401);
      expect((await admin.billRatesSetting()).status, 'GET as the host admin').toBe(403);
      expect((await admin.saveBillRatesSetting(true)).status, 'POST as the host admin').toBe(403);
      expect(switchValue(), 'nothing was saved').toBe('0');
      const own = await vendor.billRatesSetting();
      expect(own.status, own.text).toBe(200);
      expect(own.data).toEqual({ driversCanSeeBillRates: false });
    });

    test('BRATE-09 nothing this run sent ended in either dead-letter table, and both outboxes drain', async () => {
      await expect.poll(() => hostNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`), { message: 'the host outbox drains', ...QUEUE }).toBe(0);
      await expect
        .poll(() => driversNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`), { message: 'the DRIVERS outbox drains', ...QUEUE })
        .toBe(0);
      expect(
        {
          host: hostNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
          drivers: driversNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
        },
        `dead letters before the run: host ${deadLetters.host}, drivers ${deadLetters.drivers}`,
      ).toEqual(deadLetters);
    });
  },
);
