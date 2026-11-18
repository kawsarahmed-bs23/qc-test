// QC-998: Host edits the Driver must see now reach DRIVERS by message. An order save sends JobChanged (truck type), an
// assignment edit sends JobChanged with the assignment date and loads, a dispatcher status change sends
// AssignmentStatusChanged, a Host edit of a Driver's submitted ticket sends TicketAdjusted (the Host's figures, kept beside
// the Driver's own values), removing it as a duplicate sends TicketRejected (the row stays, DH20), and with Drivers:Mode
// Off nothing is sent. Local only: it reuses the QC-933 throwaway Host and Driver (@utils/changeProposalsWorld) and adds a
// throwaway order copied from order 26 (seed/host-qc998.*.sql).
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env, TEST_DATA_DIR } from '@config/env.config';
import { isDriversApiReachable } from '@api/password-grant.api';
import { ChangeProposalsApi } from '@api/change-proposals.api';
import { HostAssignmentsApi, type AssignmentSave } from '@api/host-assignments.api';
import { HostDriverEventsApi } from '@api/driver-events.api';
import { HostChangeSyncApi } from '@api/host-change-sync.api';
import { DriverTicketSubmitApi } from '@api/ticket-submit.api';
import { HostDriversMode } from '@api/sms-routing.api';
import { runSeedScript } from '@utils/localDb';
import {
  ADMIN_EMAIL,
  canRunWorld,
  driversValue,
  hostToday,
  hostValue,
  localHostUuid,
  queuesDrained,
  removeWorld,
  restoreDriversMode,
  seedWorld,
  waitForHostToSeeOrganisations,
  waitForQueues,
  type World,
} from '@utils/changeProposalsWorld';

const MARKER = 'e2e-qc998';
const SOURCE_ORDER_ID = 26;
const QUEUE = { timeout: 45_000, intervals: [500, 1_000, 2_000] };
const OCR = { timeout: 90_000, intervals: [2_000, 5_000] };
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');
const STATUS = { pending: 1, accepted: 2, rejected: 3, running: 4 } as const;

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

function hostNumber(query: string): number {
  return Number(hostValue(query) ?? '0');
}

function driversNumber(query: string): number {
  return Number(driversValue(query) ?? '0');
}

function assignmentUuid(id: number): string {
  return hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`) ?? '';
}

function driversAssignment(uuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`);
}

function driversTicket(uuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.Tickets WHERE TicketUUID = '${uuid}'`);
}

function batchMark(): number {
  return hostNumber(`SELECT ISNULL(MAX(TicketBatchID), 0) FROM app.TicketBatches`);
}

function removeOrders(mark: number): void {
  const removed = runSeedScript('host-qc998.remove.sql', { BatchMark: String(mark) });
  if (!/REMOVED left=0/.test(removed)) throw new Error(`QC-998 rows are left behind in the host database:\n${removed}`);
}

test.describe(
  'Host changes reach DRIVERS by message: order edits, assignment date and loads, status, ticket decisions (QC-998)',
  { tag: ['@write', '@regression'] },
  () => {
    test.describe.configure({ mode: 'serial', timeout: 180_000 });
    test.skip(
      !canRunWorld(),
      'Needs the host, DRIVERS and Identity local databases, ADMIN_* and DRIVER_* accounts, APP_API_URL, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
    );

    let request: APIRequestContext;
    let world: World;
    let host: HostChangeSyncApi;
    let dispatch: HostDriverEventsApi;
    let assignments: HostAssignmentsApi;
    let driver: DriverTicketSubmitApi;
    let mark = 0;
    let orderId = 0;
    let deadLetters = { host: 0, drivers: 0 };
    const offer = { id: 0, uuid: '' };
    const work = { id: 0, uuid: '', tripUuid: '', ticketUuid: '', hostTicketId: 0 };

    const assignment = (overrides: Partial<AssignmentSave>): AssignmentSave => ({
      orderId,
      assignmentDate: hostToday(),
      vendorId: world.vendorOrgId,
      truckId: world.truckA,
      driverUserId: world.driver.hostUserId,
      truckCount: null,
      loadsAssigned: 2,
      notes: MARKER,
      ...overrides,
    });

    const saveOrderWithTruckType = async (truckTypeId: number) => {
      const order = await host.order(orderId);
      const saved = await host.saveOrder(orderId, { ...order, truckTypeId });
      expect(saved.status(), await saved.text()).toBe(200);
    };

    const otherTruckType = () => {
      const current = hostNumber(`SELECT TruckTypeID_FK FROM app.Orders WHERE OrderID = ${orderId}`);
      return hostNumber(`SELECT TOP 1 TruckTypeID FROM app.List_TruckTypes WHERE Active = 1 AND TruckTypeID <> ${current} ORDER BY NEWID()`);
    };

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(480_000);
      request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      const hostUuid = localHostUuid();
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      test.skip(
        !hostUuid || driversNumber(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`) === 0,
        'The host (EnvironmentSetting Messaging:HostUuid) is not an active host in DRIVERS.',
      );
      test.skip(
        driversValue(
          `SELECT CASE WHEN COL_LENGTH(N'app.Tickets', N'HostDecision') IS NULL OR COL_LENGTH(N'app.OrderAssignments', N'TruckTypeCode') IS NULL THEN 0 ELSE 1 END`,
        ) !== '1',
        'The DRIVERS database lacks the QC-998 migrations (app.Tickets.HostDecision, app.OrderAssignments.TruckTypeCode).',
      );
      test.skip(hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE OrderID = ${SOURCE_ORDER_ID}`) === 0, `Needs order ${SOURCE_ORDER_ID} to copy.`);

      mark = batchMark();
      removeOrders(mark);
      world = await seedWorld(request, hostUuid);
      const made = runSeedScript('host-qc998.apply.sql', { SourceOrder: String(SOURCE_ORDER_ID), Today: hostToday() });
      orderId = Number(/ORDER:(\d+)/.exec(made)?.[1] ?? '0');
      expect(orderId, 'the throwaway order').toBeGreaterThan(0);

      deadLetters = {
        host: hostNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
        drivers: driversNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
      };

      const proposals = new ChangeProposalsApi(request);
      await proposals.signIn(ADMIN_EMAIL, env.admin!.password);
      await waitForHostToSeeOrganisations(proposals, world);

      host = new HostChangeSyncApi(request);
      dispatch = new HostDriverEventsApi(request);
      assignments = new HostAssignmentsApi(request);
      expect(await host.signIn(ADMIN_EMAIL, env.admin!.password), 'the throwaway host admin signs in').toBe(200);
      expect(await dispatch.signIn(ADMIN_EMAIL, env.admin!.password)).toBe(200);
      expect(await assignments.signIn(ADMIN_EMAIL, env.admin!.password)).toBe(200);
      driver = new DriverTicketSubmitApi(request, world.driver.token);
    });

    test.afterAll(async () => {
      try {
        if (world) {
          await new HostDriversMode(request).set('On');
          await waitForQueues();
        }
      } finally {
        try {
          removeOrders(mark);
          removeWorld();
        } finally {
          await restoreDriversMode(request, world);
          await request?.dispose();
        }
      }
    });

    test('HCS-01 a JobOffered for a linked driver stores the truck type code on the DRIVERS assignment', async () => {
      const created = await assignments.create(assignment({ assignmentDate: hostToday(), notes: `${MARKER} offer` }));
      expect(created.status, created.text).toBe(201);
      offer.id = Number(created.data);
      offer.uuid = assignmentUuid(offer.id);
      await expect
        .poll(() => driversAssignment(offer.uuid, 'Status, LoadsAssigned'), { message: 'JobOffered reaches DRIVERS', ...QUEUE })
        .toBe(`${STATUS.pending}|2`);
      expect(driversAssignment(offer.uuid, `ISNULL(TruckTypeCode, '-')`), 'the truck type code is stored').not.toBe('-');
    });

    test('HCS-02 saving the order with another truck type sends JobChanged, and DRIVERS gets the new truck type code', async () => {
      expect(offer.uuid, 'HCS-01 created the assignment').not.toBe('');
      const before = driversAssignment(offer.uuid, 'TruckTypeCode, Version');
      await saveOrderWithTruckType(otherTruckType());
      await expect.poll(() => driversAssignment(offer.uuid, 'TruckTypeCode, Version'), { message: 'JobChanged reaches DRIVERS', ...QUEUE }).not.toBe(before);
      expect(driversAssignment(offer.uuid, 'TruckTypeCode'), 'the truck type code changed').not.toBe(before!.split('|')[0]);
    });

    test('HCS-03 moving the assignment to tomorrow with 3 loads sends JobChanged with the date and loads, and DRIVERS applies them', async () => {
      expect(offer.uuid, 'HCS-01 created the assignment').not.toBe('');
      const tomorrow = addDays(hostToday(), 1);
      const moved = await assignments.update(offer.id, assignment({ assignmentDate: tomorrow, loadsAssigned: 3, notes: `${MARKER} offer` }));
      expect(moved.status, moved.text).toBe(200);
      await expect
        .poll(() => driversAssignment(offer.uuid, 'CONVERT(varchar(10), AssignmentDate, 23), LoadsAssigned, FulfillmentType'), {
          message: 'JobChanged moves the DRIVERS date and loads',
          ...QUEUE,
        })
        .toBe(`${tomorrow}|3|10`);
      expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${offer.uuid}'`), 'still one DRIVERS row').toBe(1);
    });

    test('HCS-04 a dispatcher setting Accepted then Rejected sends AssignmentStatusChanged each time, and DRIVERS follows without deleting the row', async () => {
      expect(offer.uuid, 'HCS-01 created the assignment').not.toBe('');
      const accepted = await dispatch.setStatus(offer.id, 'Accepted', `${MARKER} dispatcher accepted`);
      expect(accepted.status(), await accepted.text()).toBe(200);
      await expect.poll(() => driversAssignment(offer.uuid, 'Status'), { message: 'AssignmentStatusChanged accepted', ...QUEUE }).toBe(String(STATUS.accepted));

      const rejected = await dispatch.setStatus(offer.id, 'Rejected', `${MARKER} dispatcher rejected`);
      expect(rejected.status(), await rejected.text()).toBe(200);
      await expect.poll(() => driversAssignment(offer.uuid, 'Status'), { message: 'AssignmentStatusChanged rejected', ...QUEUE }).toBe(String(STATUS.rejected));
      expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${offer.uuid}'`), 'the row is kept (DH20)').toBe(1);
      expect(
        hostNumber(
          `SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${offer.id} AND OrderAssignmentHistoryData LIKE N'Status % sent to the Driver.'`,
        ),
        'the host records each status it sent',
      ).toBe(2);
    });

    test('HCS-05 a Host edit of a Driver-submitted ticket sends TicketAdjusted: DRIVERS keeps the Driver values and stores the Host quantity beside them', async () => {
      const created = await assignments.create(assignment({ assignmentDate: hostToday(), loadsAssigned: 1, notes: `${MARKER} work` }));
      expect(created.status, created.text).toBe(201);
      work.id = Number(created.data);
      work.uuid = assignmentUuid(work.id);
      await expect.poll(() => driversAssignment(work.uuid, 'Status'), { message: 'JobOffered reaches DRIVERS', ...QUEUE }).toBe(String(STATUS.pending));

      const accepted = await driver.accept(work.uuid);
      expect(accepted.status(), await accepted.text()).toBe(202);
      await expect
        .poll(() => hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${work.id}`), QUEUE)
        .toBe(STATUS.accepted);

      work.tripUuid = randomUUID();
      const begun = await driver.beginHaulWithTrip(work.uuid, work.tripUuid);
      expect(begun.status(), await begun.text()).toBe(202);
      await expect.poll(() => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), { message: 'TripStarted', ...QUEUE }).toBe(1);
      const ended = await driver.endHaul(work.tripUuid);
      expect(ended.status(), await ended.text()).toBe(202);
      await expect.poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), { message: 'TripCompleted', ...QUEUE }).toBe(30);

      work.ticketUuid = randomUUID();
      const photo = { name: `${MARKER}-ticket.jpg`, mimeType: 'image/jpeg', buffer: fs.readFileSync(TICKET_JPEG) };
      const uploaded = await driver.upload(work.tripUuid, photo, { ticketUuid: work.ticketUuid });
      expect(uploaded.status(), await uploaded.text()).toBe(202);
      await expect.poll(() => [20, 30].includes(Number(driversTicket(work.ticketUuid, 'Status'))), { message: 'the photo is read', ...OCR }).toBe(true);

      const submitted = { ticketNumber: `QC998-${Date.now() % 100_000}`, ticketDate: hostToday(), ticketQuantity: 12.5 };
      const sent = await driver.submit(work.tripUuid, submitted);
      expect(sent.status(), await sent.text()).toBe(202);
      await expect
        .poll(() => hostNumber(`SELECT ISNULL(MIN(TicketID), 0) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}' AND Active = 1`), {
          message: 'TicketSubmitted makes the host ticket',
          ...OCR,
        })
        .toBeGreaterThan(0);
      work.hostTicketId = hostNumber(`SELECT MIN(TicketID) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}'`);
      await expect
        .poll(() => driversTicket(work.ticketUuid, `Status, CASE WHEN ReceivedAt IS NULL THEN 'open' ELSE 'received' END`), {
          message: 'TicketReceived, now sent through the notifier, reaches DRIVERS',
          ...QUEUE,
        })
        .toBe('50|received');
      const jobId = hostNumber(`SELECT JobID_FK FROM app.Tickets WHERE TicketID = ${work.hostTicketId}`);

      const edited = await host.updateTicket({
        ticketId: work.hostTicketId,
        ticketNumber: submitted.ticketNumber,
        ticketDate: submitted.ticketDate,
        ticketQuantity: 11.25,
        jobCode: String(jobId),
      });
      expect(edited.status(), await edited.text()).toBe(200);
      await expect
        .poll(() => driversTicket(work.ticketUuid, `ISNULL(HostDecision, '-'), HostTicketQuantity, HostTicketNumber, CAST(HostBillingLocked AS int)`), {
          message: 'TicketAdjusted reaches DRIVERS',
          ...QUEUE,
        })
        .toBe(`adjusted|11.25|${submitted.ticketNumber}|0`);
      expect(driversTicket(work.ticketUuid, 'TicketNumber, TicketQuantity'), 'the Driver values are untouched (DH19)').toBe(`${submitted.ticketNumber}|12.50`);
    });

    test('HCS-06 removing the Driver ticket as a duplicate sends TicketRejected: DRIVERS keeps the ticket and marks the Host decision rejected', async () => {
      expect(work.hostTicketId, 'HCS-05 made the host ticket').toBeGreaterThan(0);
      const copy = hostValue(
        `DECLARE @Cols nvarchar(max) = (SELECT STRING_AGG(QUOTENAME(name), ',') FROM sys.columns WHERE object_id = OBJECT_ID(N'app.Tickets')
         AND is_identity = 0 AND is_computed = 0 AND system_type_id <> 189 AND name NOT IN (N'TicketUUID', N'TripID_FK'));
       DECLARE @Sql nvarchar(max) = N'INSERT app.Tickets (' + @Cols + N', TicketUUID, TripID_FK) SELECT ' + @Cols
         + N', NEWID(), NULL FROM app.Tickets WHERE TicketID = @Id; SELECT CAST(SCOPE_IDENTITY() AS int);';
       EXEC sp_executesql @Sql, N'@Id int', ${work.hostTicketId};`,
      );
      expect(Number(copy ?? '0'), 'a duplicate host ticket with the same number').toBeGreaterThan(0);

      const removed = await host.removeDuplicateTicket(work.hostTicketId);
      expect(removed.status(), await removed.text()).toBe(200);
      await expect
        .poll(() => driversTicket(work.ticketUuid, `ISNULL(HostDecision, '-'), ISNULL(HostDecisionReason, '-')`), {
          message: 'TicketRejected reaches DRIVERS',
          ...QUEUE,
        })
        .toBe('rejected|duplicate');
      expect(driversNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}' AND Active = 1`), 'the Driver ticket stays (DH20)').toBe(
        1,
      );
    });

    test('HCS-07 with Drivers:Mode Off an order save sends nothing, and DRIVERS keeps the earlier truck type code', async () => {
      expect(offer.uuid, 'HCS-01 created the assignment').not.toBe('');
      const pending = await assignments.create(assignment({ assignmentDate: addDays(hostToday(), 2), loadsAssigned: 1, notes: `${MARKER} mode` }));
      expect(pending.status, pending.text).toBe(201);
      const uuid = assignmentUuid(Number(pending.data));
      await expect.poll(() => driversAssignment(uuid, 'Status'), { message: 'JobOffered reaches DRIVERS', ...QUEUE }).toBe(String(STATUS.pending));
      const before = driversAssignment(uuid, 'TruckTypeCode, Version');

      await new HostDriversMode(request).set('Off');
      try {
        await expect.poll(() => new HostDriversMode(request).current(), QUEUE).toBe('Off');
        await saveOrderWithTruckType(otherTruckType());
        await expect.poll(queuesDrained, { message: 'both queues settle', ...QUEUE }).toBe(true);
        expect(driversAssignment(uuid, 'TruckTypeCode, Version'), 'nothing reached DRIVERS').toBe(before);
      } finally {
        await new HostDriversMode(request).set('On');
      }
    });

    test('HCS-08 nothing this run sent ended in either dead-letter table, and both outboxes drain', async () => {
      await waitForQueues();
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
