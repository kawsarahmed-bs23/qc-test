import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, canUseDriversDb, driversColumns, queryDriversDb, querySingleValue, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { HostDriverEventsApi } from '@api/driver-events.api';
import { isReplayed } from '@api/driver-sync.api';
import { HostAssignmentsApi, type AssignmentSave } from '@api/host-assignments.api';
import { isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { DriverTicketSubmitApi, sha256Hex, type GpsPing } from '@api/ticket-submit.api';
import { env, TEST_DATA_DIR } from '@config/env.config';

const MARKER = 'e2e-qc873';
const DEVICE = `${MARKER}-device`;
const SOURCE_ORDER_ID = 26;
const SECOND_SOURCE_ORDER_ID = 25;
const VENDOR_ID = 34;
const TRUCK_ID = 38;
const SECOND_DRIVER_ID = '099d0449-2094-4323-a644-6a63c49ba30e';
const SECOND_TRUCK_ID = 43;
const QUEUE = { timeout: 20_000, intervals: [500, 1_000, 2_000] };
const OCR = { timeout: 90_000, intervals: [2_000, 5_000] };
const RECEIVED = { timeout: 60_000, intervals: [1_000, 2_000, 5_000] };
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');
const RUNNING_HAUL = 'This load is running. Ask the Driver to End Haul first.';
const APP_UPDATE = 'This action is not available until the Driver App update.';

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

function tokenSubject(accessToken: string): string {
  const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as { sub?: string };
  return (payload.sub ?? '').toLowerCase();
}

function secondsAgo(seconds: number): string {
  return new Date(Math.floor((Date.now() - seconds * 1_000) / 1_000) * 1_000).toISOString();
}

function assignmentUuid(id: number): string {
  return hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`)!;
}

function hostStatus(id: number): number {
  return hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

function hostTripId(tripUuid: string): number {
  return hostNumber(`SELECT TripID FROM app.Trips WHERE TripUUID = '${tripUuid}'`);
}

function driversAssignment(uuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`);
}

function driversTripStatus(tripUuid: string): number {
  return driversNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`);
}

function driversTicket(ticketUuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.Tickets WHERE TicketUUID = '${ticketUuid}'`);
}

function readDone(ticketUuid: string): boolean {
  return [20, 30].includes(Number(driversTicket(ticketUuid, 'Status')));
}

function driversGps(uuid: string): string | null {
  return driversValue(
    `SELECT CONCAT(COUNT(*), '|', LOWER(CONVERT(nvarchar(36), MIN(HostUUID))), '|', LOWER(CONVERT(nvarchar(36), MIN(OrderAssignmentUUID))), '|', LOWER(CONVERT(nvarchar(36), MIN(TripUUID))), '|', MAX(CAST(IsFlagged AS int)), '|', ISNULL(MIN(FlagReason), '-'), '|', SUM(CASE WHEN SentAt IS NULL THEN 0 ELSE 1 END)) FROM app.TripGps WHERE TripGpsUUID = '${uuid}'`,
  );
}

function hostGps(uuid: string): string | null {
  return hostValue(
    `SELECT CONCAT(COUNT(*), '|', ISNULL(MIN(OrderAssignmentID_FK), 0), '|', ISNULL(MIN(TripID_FK), 0)) FROM app.TripGps WHERE TripGpsUUID = '${uuid}'`,
  );
}

function hostTicketsOnTrip(tripUuid: string): number {
  return (
    hostNumber(`SELECT COUNT(*) FROM app.Tickets k JOIN app.Trips t ON t.TripID = k.TripID_FK WHERE t.TripUUID = '${tripUuid}'`) +
    hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE TripUUID = '${tripUuid}' AND TicketID_FK IS NOT NULL`)
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

test.describe(
  'Drivers API keeps tickets until Submit, stores GPS first and never calls a host API; the host refuses to cancel a running load (QC-873)',
  { tag: ['@write', '@regression'] },
  () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedLocalDb() || !canUseDriversDb(), 'Needs the host and DRIVERS local databases (local only).');
    test.skip(!env.appAdmin || !env.driver, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD and DRIVER_EMAIL / DRIVER_PASSWORD.');
    test.skip(!env.appApiUrl || !env.driversApiUrl, 'Needs APP_API_URL and DRIVERS_API_URL.');

    let host: HostDriverEventsApi;
    let assignments: HostAssignmentsApi;
    let driver: DriverTicketSubmitApi;
    let hostUuid = '';
    let driverId = '';
    let driverUuid = '';
    let batchMark: string | null = null;
    const orders = { work: 0, second: 0 };
    let deadLetters = { host: 0, drivers: 0 };
    const photo = fs.readFileSync(TICKET_JPEG);
    const otherPhoto = Buffer.concat([photo, Buffer.from(`${MARKER} second photo`)]);
    const ticketFile = (buffer: Buffer) => ({ name: `${MARKER}-ticket.jpg`, mimeType: 'image/jpeg', buffer });
    const work = { id: 0, uuid: '', tripUuid: '', ticketUuid: '' };
    const second = { id: 0, uuid: '', tripUuid: '' };
    const submitted = { ticketNumber: `QC873-${Date.now() % 100_000}`, ticketDate: hostToday(), ticketQuantity: 12.5 };

    const assignment = (overrides: Partial<AssignmentSave>): AssignmentSave => ({
      orderId: orders.work,
      assignmentDate: hostToday(),
      vendorId: VENDOR_ID,
      truckId: TRUCK_ID,
      driverUserId: driverId,
      truckCount: null,
      loadsAssigned: 2,
      notes: MARKER,
      ...overrides,
    });

    const removeAll = () => {
      runDriversSeedScript('drivers-qc873.remove.sql');
      runSeedScript('host-qc873.remove.sql', { BatchMark: batchMark ?? '2147483647' });
    };

    const offerAcceptBegin = async (target: { id: number; uuid: string; tripUuid: string }, save: AssignmentSave) => {
      const created = await assignments.create(save);
      expect(created.status, created.text).toBe(201);
      target.id = Number(created.data);
      target.uuid = assignmentUuid(target.id);
      await expect
        .poll(() => driversAssignment(target.uuid, `Status, ${driversColumns().text(driversColumns().driverUser)}`), {
          message: 'JobOffered reaches DRIVERS',
          ...QUEUE,
        })
        .toBe(`1|${driverUuid}`);

      const accepted = await driver.accept(target.uuid);
      expect(accepted.status(), await accepted.text()).toBe(202);
      await expect.poll(() => hostStatus(target.id), { message: 'JobAccepted reaches the host', ...QUEUE }).toBe(2);

      target.tripUuid = randomUUID();
      const begun = await driver.beginHaulWithTrip(target.uuid, target.tripUuid);
      expect(begun.status(), await begun.text()).toBe(202);
      await expect.poll(() => hostTripId(target.tripUuid), { message: 'TripStarted creates the host trip', ...QUEUE }).toBeGreaterThan(0);
      await expect.poll(() => hostStatus(target.id), { message: 'the host assignment is Running', ...QUEUE }).toBe(4);
      expect(driversTripStatus(target.tripUuid), 'the DRIVERS trip is Active').toBe(20);
    };

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(90_000);
      hostUuid = (
        driversValue(
          `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE ${driversColumns().hostName} = ${sqlText(env.hostName)} AND Active = 1`,
        ) ?? ''
      ).toLowerCase();
      test.skip(!hostUuid, `The host '${env.hostName}' (HOST_NAME) is not an active host in DRIVERS.`);
      test.skip(
        driversNumber(`SELECT CASE WHEN OBJECT_ID(N'app.TripGps', N'U') IS NULL OR COL_LENGTH(N'app.Tickets', N'SubmittedAt') IS NULL THEN 0 ELSE 1 END`) === 0,
        'DRIVERS_SQL_DATABASE lacks the QC-873 migrations (app.TripGps, app.Tickets.SubmittedAt).',
      );
      test.skip(
        hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE OrderID IN (${SOURCE_ORDER_ID}, ${SECOND_SOURCE_ORDER_ID})`) < 2,
        `Needs orders ${SOURCE_ORDER_ID} and ${SECOND_SOURCE_ORDER_ID} of the local copy to copy.`,
      );

      const probe = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        test.skip(!(await isDriversApiReachable(probe)), 'The drivers API (DRIVERS_API_URL) is not running.');
        const token = await new PasswordGrantApi(probe).passwordGrant(env.driver!.email, env.driver!.password);
        expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
        driverUuid = tokenSubject(token.body.access_token!);
        driver = new DriverTicketSubmitApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), token.body.access_token!);
      } finally {
        await probe.dispose();
      }
      driverId = hostValue(`SELECT Id FROM auth.Users WHERE UserUUID = '${driverUuid}'`) ?? '';
      test.skip(!driverId, 'The DRIVER_EMAIL account (by its UserUUID) is not a host user.');
      test.skip(
        driversNumber(
          `SELECT COUNT(*) FROM app.DriverHostLinks l JOIN app.Hosts h ON h.${driversColumns().hostKey} = l.${driversColumns().host} WHERE l.${driversColumns().user} = ${sqlText(driverUuid)} AND h.HostUUID = '${hostUuid}' AND l.Active = 1`,
        ) === 0,
        'The DRIVER_EMAIL account is not linked to the host in DRIVERS.',
      );
      test.skip(
        driversNumber(`SELECT COUNT(*) FROM app.Trips WHERE UserUUID = '${driverUuid}' AND Status IN (20, 40) AND Active = 1`) > 0,
        'The DRIVER_EMAIL driver already has an open load in DRIVERS, so begin-haul would be refused.',
      );

      batchMark = hostValue(`SELECT ISNULL(MAX(TicketBatchID), 0) FROM app.TicketBatches`);
      removeAll();
      const seeded = /ORDERS:(\d+),(\d+)/.exec(
        runSeedScript('host-qc873.apply.sql', { SourceOrderA: String(SECOND_SOURCE_ORDER_ID), SourceOrderB: String(SOURCE_ORDER_ID), Today: hostToday() }),
      );
      expect(seeded, 'seed/host-qc873.apply.sql made two orders').not.toBeNull();
      orders.second = Number(seeded![1]);
      orders.work = Number(seeded![2]);
      deadLetters = {
        host: hostNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
        drivers: driversNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
      };

      const hostContext = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      host = new HostDriverEventsApi(hostContext);
      assignments = new HostAssignmentsApi(hostContext);
      expect(await host.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the host admin signs in to the host API').toBe(200);
      expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    });

    test.afterAll(async () => {
      await waitForQueues();
      removeAll();
    });

    test('TSUB-01 an offer the driver accepts and begins makes a Running host assignment with the client TripUUID', async () => {
      await offerAcceptBegin(work, assignment({ notes: `${MARKER} work` }));
      expect(
        hostValue(`SELECT LOWER(CONVERT(nvarchar(36), TripUUID)) FROM app.Trips WHERE OrderAssignmentID_FK = ${work.id}`),
        'the host trip keeps the client TripUUID',
      ).toBe(work.tripUuid);
    });

    test('TSUB-02 tagged GPS points are stored in DRIVERS app.TripGps first and copied to the host by TripGpsUUID, and the same batch again adds nothing on either side', async () => {
      expect(work.tripUuid, 'TSUB-01 began a load').not.toBe('');
      const tripId = hostTripId(work.tripUuid);
      const pings: GpsPing[] = [0, 1, 2].map((i) => ({
        TripGpsUUID: randomUUID(),
        lat: 29.989 + i / 1000,
        lng: -97.877,
        accuracyMeters: 5,
        isMoving: true,
        recordedAt: secondsAgo(40 - i * 10),
        tripUuid: work.tripUuid,
        orderAssignmentUuid: work.uuid,
      }));

      const first = await driver.gpsPings(pings, DEVICE);
      expect(first.status(), await first.text()).toBe(202);
      for (const ping of pings) {
        expect(driversGps(ping.TripGpsUUID!), 'stored in DRIVERS with its host, assignment and trip, not flagged, sent').toBe(
          `1|${hostUuid}|${work.uuid}|${work.tripUuid}|0|-|1`,
        );
      }
      for (const ping of pings) {
        await expect
          .poll(() => hostGps(ping.TripGpsUUID!), { message: 'GpsTraceUploaded stores the host copy by TripGpsUUID', ...QUEUE })
          .toBe(`1|${work.id}|${tripId}`);
      }

      const again = await driver.gpsPings(pings, DEVICE);
      expect(again.status(), await again.text()).toBe(202);
      await expect.poll(queuesDrained, { message: 'both queues settle after the repeat batch', ...QUEUE }).toBe(true);
      const uuids = pings.map((p) => `'${p.TripGpsUUID}'`).join(', ');
      expect(driversNumber(`SELECT COUNT(*) FROM app.TripGps WHERE TripGpsUUID IN (${uuids})`), 'DRIVERS keeps one row per TripGpsUUID').toBe(3);
      expect(hostNumber(`SELECT COUNT(*) FROM app.TripGps WHERE TripGpsUUID IN (${uuids})`), 'the host keeps one row per TripGpsUUID').toBe(3);
    });

    test('TSUB-03 a point for an unknown trip is 202 and stored flagged unknown-trip without a host copy, and a point outside its trip is flagged outside-trip but still sent', async () => {
      expect(work.tripUuid, 'TSUB-01 began a load').not.toBe('');
      const unknownTrip = randomUUID();
      const unknown: GpsPing = { TripGpsUUID: randomUUID(), lat: 29.99, lng: -97.87, isMoving: true, recordedAt: secondsAgo(3), tripUuid: unknownTrip };
      const early: GpsPing = { TripGpsUUID: randomUUID(), lat: 29.98, lng: -97.86, isMoving: true, recordedAt: secondsAgo(2 * 3600), tripUuid: work.tripUuid };

      const sent = await driver.gpsPings([unknown, early], DEVICE);
      expect(sent.status(), await sent.text()).toBe(202);
      expect(driversGps(unknown.TripGpsUUID!), 'unknown trip: stored, flagged, not sent').toBe(`1|||${unknownTrip}|1|unknown-trip|0`);
      expect(driversGps(early.TripGpsUUID!), 'outside the trip: flagged but sent').toBe(`1|${hostUuid}|${work.uuid}|${work.tripUuid}|1|outside-trip|1`);
      await expect
        .poll(() => hostGps(early.TripGpsUUID!), { message: 'the outside-trip point reaches the host', ...QUEUE })
        .toBe(`1|${work.id}|${hostTripId(work.tripUuid)}`);
      await expect.poll(queuesDrained, { message: 'both queues settle', ...QUEUE }).toBe(true);
      expect(hostGps(unknown.TripGpsUUID!), 'the unknown-trip point never reaches the host').toBe('0|0|0');
    });

    test('TSUB-04 end-haul completes the trip in DRIVERS and on the host', async () => {
      expect(work.tripUuid, 'TSUB-01 began a load').not.toBe('');
      const ended = await driver.endHaul(work.tripUuid);
      expect(ended.status(), await ended.text()).toBe(202);
      expect(driversTripStatus(work.tripUuid), 'the DRIVERS trip is Complete at once').toBe(30);
      await expect
        .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE })
        .toBe(30);
    });

    test('TSUB-05 a ticket photo upload is saved in DRIVERS with the phone TicketUUID, Status 10 and its SHA-256, and nothing reaches the host', async () => {
      expect(work.tripUuid, 'TSUB-01 began a load').not.toBe('');
      work.ticketUuid = randomUUID();
      const uploaded = await driver.upload(work.tripUuid, ticketFile(photo), { ticketUuid: work.ticketUuid });
      expect(uploaded.status(), await uploaded.text()).toBe(202);
      const trip = (await uploaded.json()).data as { ticketUuid: string; ticketStatus: string };
      expect(trip.ticketUuid.toLowerCase(), 'the phone TicketUUID is kept').toBe(work.ticketUuid);
      expect(trip.ticketStatus, 'the upload answers uploaded').toBe('uploaded');

      expect(
        driversTicket(
          work.ticketUuid,
          `LOWER(CONVERT(nvarchar(36), TripUUID)), LOWER(ImageSha256), CASE WHEN SubmittedAt IS NULL THEN 'open' ELSE 'submitted' END`,
        ),
        'one DRIVERS ticket on the trip with the photo SHA-256, not submitted',
      ).toBe(`${work.tripUuid}|${sha256Hex(photo)}|open`);
      expect([10, 20, 30], 'Status is 10 (or already read)').toContain(Number(driversTicket(work.ticketUuid, 'Status')));
      expect(driversTicket(work.ticketUuid, 'ImageKey'), 'the S3 key').toMatch(
        new RegExp(`drivers/tickets/${hostUuid}/${driverUuid}/${work.ticketUuid}\\.jpg$`, 'i'),
      );
      await expect.poll(queuesDrained, { message: 'both queues settle', ...QUEUE }).toBe(true);
      expect(hostNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}'`), 'no host ticket with that TicketUUID').toBe(0);
      expect(hostTicketsOnTrip(work.tripUuid), 'no host ticket on the trip').toBe(0);
    });

    test('TSUB-06 the ticket reader finishes within 90 s with Status 20 (read) or 30 (failed), and the status route shows what it found', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      test.setTimeout(120_000);
      await expect.poll(() => readDone(work.ticketUuid), { message: 'the TicketWorkerService reads the photo', ...OCR }).toBe(true);
      const status = Number(driversTicket(work.ticketUuid, 'Status'));
      const trip = await driver.ticketTrip(work.tripUuid);
      test.info().annotations.push({
        type: 'ocr',
        description: `Status ${status}: number ${trip.ocrTicketNumber ?? '-'}, date ${trip.ocrTicketDate ?? '-'}, quantity ${trip.ocrTicketQuantity ?? '-'}, error ${trip.ocrError ?? '-'}`,
      });
      expect(trip.ticketStatus).toBe(status === 20 ? 'processed' : 'failed');
      if (status === 30) expect(trip.ocrError, 'a failed read says why').toBeTruthy();
      expect(trip.canSubmitTicket, 'the driver can submit').toBe(true);
      expect(trip.ticketSubmittedAt).toBeNull();
      expect(trip.ticketReceivedAt).toBeNull();
    });

    test('TSUB-07 the same photo again is replayed, a matching X-Content-SHA256 replays too, and a mismatching one is 400', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      const updated = driversTicket(work.ticketUuid, 'CONVERT(varchar(30), Updated, 126)');

      const again = await driver.upload(work.tripUuid, ticketFile(photo));
      expect(again.status(), await again.text()).toBe(202);
      expect(isReplayed(again), 'Idempotent-Replayed: true').toBe(true);

      const hashed = await driver.upload(work.tripUuid, ticketFile(photo), { sha256: sha256Hex(photo).toUpperCase() });
      expect(hashed.status(), await hashed.text()).toBe(202);
      expect(isReplayed(hashed), 'Idempotent-Replayed: true').toBe(true);

      const wrong = await driver.upload(work.tripUuid, ticketFile(photo), { sha256: sha256Hex(otherPhoto) });
      expect(wrong.status(), await wrong.text()).toBe(400);

      expect(driversNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TripUUID = '${work.tripUuid}'`), 'still one DRIVERS ticket').toBe(1);
      expect(driversTicket(work.ticketUuid, 'CONVERT(varchar(30), Updated, 126)'), 'the ticket row is untouched').toBe(updated);
    });

    test('TSUB-08 reprocess re-queues the photo (Status 10) and the reader finishes it again', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      test.setTimeout(120_000);
      const reprocessed = await driver.reprocess(work.tripUuid);
      expect(reprocessed.status(), await reprocessed.text()).toBe(202);
      expect(((await reprocessed.json()).data as { ticketStatus: string }).ticketStatus, 'answers uploaded').toBe('uploaded');
      await expect.poll(() => readDone(work.ticketUuid), { message: 'the reader finishes again', ...OCR }).toBe(true);
    });

    test('TSUB-09 Submit without the quantity, number or date is 400 and submits nothing', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      const answers = {
        quantity: (await driver.submit(work.tripUuid, { ticketNumber: submitted.ticketNumber, ticketDate: submitted.ticketDate })).status(),
        number: (await driver.submit(work.tripUuid, { ticketDate: submitted.ticketDate, ticketQuantity: submitted.ticketQuantity })).status(),
        date: (await driver.submit(work.tripUuid, { ticketNumber: submitted.ticketNumber, ticketQuantity: submitted.ticketQuantity })).status(),
      };
      expect(answers).toEqual({ quantity: 400, number: 400, date: 400 });
      expect(driversTicket(work.ticketUuid, `ISNULL(CONVERT(varchar(30), SubmittedAt, 126), 'none')`), 'not submitted').toBe('none');
    });

    test('TSUB-10 a ticket reaches the host only after Submit: Submit is 202 and Status 40, the host stores the ticket with that TicketUUID and its image, and DRIVERS gets ReceivedAt and Status 50', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      await expect.poll(queuesDrained, { message: 'both queues settle before Submit', ...QUEUE }).toBe(true);
      expect(hostTicketsOnTrip(work.tripUuid), 'before Submit the host has no ticket for the trip').toBe(0);

      const sent = await driver.submit(work.tripUuid, submitted);
      expect(sent.status(), await sent.text()).toBe(202);
      expect(
        driversTicket(
          work.ticketUuid,
          `CASE WHEN SubmittedAt IS NULL THEN 'open' ELSE 'submitted' END, TicketNumber, CONVERT(varchar(10), TicketDate, 23), TicketQuantity`,
        ),
        'DRIVERS keeps the driver values',
      ).toBe(`submitted|${submitted.ticketNumber}|${submitted.ticketDate}|12.50`);
      expect([40, 50], 'Status 40 (or already received)').toContain(Number(driversTicket(work.ticketUuid, 'Status')));
      expect(
        driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE TargetUUID = '${work.ticketUuid}' AND CommandType = 'review-ticket'`),
        'one review-ticket command',
      ).toBe(1);

      const tripId = hostTripId(work.tripUuid);
      await expect
        .poll(
          () =>
            hostValue(
              `SELECT CONCAT(COUNT(*), '|', MIN(TicketNumber), '|', MIN(CONVERT(varchar(20), CAST(TicketQuantity AS decimal(18, 2)))), '|', MIN(TripID_FK), '|', MIN(CASE WHEN ISNULL(ImagePath, '') = '' THEN 'no-image' ELSE 'image' END)) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}' AND Active = 1`,
            ),
          { message: 'TicketSubmitted makes one host ticket with the DRIVERS TicketUUID, the values, the trip and the copied image', ...RECEIVED },
        )
        .toBe(`1|${submitted.ticketNumber}|12.50|${tripId}|image`);
      await expect
        .poll(() => driversTicket(work.ticketUuid, `Status, CASE WHEN ReceivedAt IS NULL THEN 'waiting' ELSE 'received' END`), {
          message: 'TicketReceived sets ReceivedAt and Status 50',
          ...RECEIVED,
        })
        .toBe('50|received');
    });

    test('TSUB-11 Submit again with the same values replays, with other values is 409, and a new photo after Submit is 409', async () => {
      expect(work.ticketUuid, 'TSUB-05 uploaded a photo').not.toBe('');
      const same = await driver.submit(work.tripUuid, submitted);
      expect(same.status(), await same.text()).toBe(202);
      expect(isReplayed(same), 'Idempotent-Replayed: true').toBe(true);

      const other = await driver.submit(work.tripUuid, { ...submitted, ticketQuantity: 99 });
      expect(other.status(), await other.text()).toBe(409);

      const newPhoto = await driver.upload(work.tripUuid, ticketFile(otherPhoto));
      expect(newPhoto.status(), await newPhoto.text()).toBe(409);

      const trip = await driver.ticketTrip(work.tripUuid);
      expect({ status: trip.ticketStatus, canSubmit: trip.canSubmitTicket, quantity: Number(trip.ticketQuantity) }).toEqual({
        status: 'received',
        canSubmit: false,
        quantity: 12.5,
      });
      expect(trip.ticketSubmittedAt, 'ticketSubmittedAt').toBeTruthy();
      expect(trip.ticketReceivedAt, 'ticketReceivedAt').toBeTruthy();
      expect(hostNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TicketUUID = '${work.ticketUuid}'`), 'still one host ticket').toBe(1);
    });

    test('TSUB-12 a host change sent after End Haul (time-window JobChanged) is logged, not applied: DRIVERS keeps the hauled time window, the trip stays Complete and the ticket received', async () => {
      expect(work.id, 'TSUB-01 made the assignment').toBeGreaterThan(0);
      const before = driversAssignment(work.uuid, 'CONVERT(varchar(5), TimeWindowStart, 108), CONVERT(varchar(5), TimeWindowEnd, 108)');
      const changed = await host.setTimeWindow(work.id, '07:15', '16:45');
      expect(changed.status(), await changed.text()).toBe(200);
      await waitForQueues();
      expect(
        driversAssignment(work.uuid, 'CONVERT(varchar(5), TimeWindowStart, 108), CONVERT(varchar(5), TimeWindowEnd, 108)'),
        'a JobChanged after Begin Haul does not change the hauled assignment in DRIVERS',
      ).toBe(before);
      expect(driversTripStatus(work.tripUuid), 'the DRIVERS trip stays Complete').toBe(30);
      expect(Number(driversTicket(work.ticketUuid, 'Status')), 'the ticket stays received').toBe(50);
    });

    test('TSUB-13 marking a thread seen is 200 and sets SeenByDriverAt in DRIVERS', async () => {
      expect(work.id, 'TSUB-01 made the assignment').toBeGreaterThan(0);
      const body = `${MARKER} seen ${Date.now()}`;
      const dispatched = await host.sendDispatchMessage(driverId, work.id, body);
      expect(dispatched.status(), await dispatched.text()).toBe(200);
      const unseen = () =>
        driversNumber(
          `SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentUUID = '${work.uuid}' AND MessageBody = ${sqlText(body)} AND SeenByDriverAt IS NULL`,
        );
      await expect.poll(unseen, { message: 'MessageSent reaches DRIVERS unseen', ...QUEUE }).toBe(1);

      const seen = await driver.markSeen(work.uuid);
      expect(seen.status(), await seen.text()).toBe(200);
      expect(unseen(), 'the message is seen').toBe(0);
      expect(
        driversNumber(
          `SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentUUID = '${work.uuid}' AND MessageBody = ${sqlText(body)} AND SeenByDriverAt IS NOT NULL`,
        ),
      ).toBe(1);
    });

    test('TSUB-14 POST /sync applies mark-thread-seen, and reopen-haul, finish-day and report-problem stay conflict (409 on their routes) until the Driver App update', async () => {
      expect(work.tripUuid, 'TSUB-01 began a load').not.toBe('');
      const body = `${MARKER} sync seen ${Date.now()}`;
      expect((await host.sendDispatchMessage(driverId, work.id, body)).status()).toBe(200);
      const unseen = () =>
        driversNumber(
          `SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentUUID = '${work.uuid}' AND MessageBody = ${sqlText(body)} AND SeenByDriverAt IS NULL`,
        );
      await expect.poll(unseen, { message: 'MessageSent reaches DRIVERS unseen', ...QUEUE }).toBe(1);

      const results = await driver.syncOperations([
        { key: randomUUID(), type: 'mark-thread-seen', targetUuid: work.uuid },
        { key: randomUUID(), type: 'reopen-haul', targetUuid: work.tripUuid },
        { key: randomUUID(), type: 'finish-day', targetUuid: work.uuid, notes: MARKER },
        { key: randomUUID(), type: 'report-problem', targetUuid: work.tripUuid, notes: MARKER },
      ]);
      expect(results.map((r) => `${r.type}:${r.status}`)).toEqual([
        'mark-thread-seen:sent',
        'reopen-haul:conflict',
        'finish-day:conflict',
        'report-problem:conflict',
      ]);
      expect(results.slice(1).map((r) => r.error)).toEqual([APP_UPDATE, APP_UPDATE, APP_UPDATE]);
      expect(unseen(), 'mark-thread-seen marked the message').toBe(0);

      for (const response of [
        await driver.reopenHaul(work.tripUuid),
        await driver.finishDay(work.uuid, MARKER),
        await driver.reportProblem(work.tripUuid, MARKER),
      ]) {
        expect(response.status(), response.url()).toBe(409);
        expect(await response.text(), response.url()).toContain(APP_UPDATE);
      }
      expect(driversTripStatus(work.tripUuid), 'the trip is unchanged').toBe(30);
    });

    test('TSUB-15 GET /me with X-Host-Uuid fills host from DRIVERS: the as-hauled vendor and truck of the latest assignment', async () => {
      const response = await driver.me(hostUuid);
      expect(response.status(), await response.text()).toBe(200);
      const json = (await response.json()) as { data?: Record<string, unknown> } & Record<string, unknown>;
      const me = (json.data ?? json) as {
        hostUuid: string;
        hostDataAvailable: boolean;
        host: { hostUuid: string; vendor: string | null; truck: string | null } | null;
      };
      const latest = driversValue(
        `SELECT TOP 1 CONCAT(ISNULL(VendorName, ''), '|', ISNULL(TruckName, '')) FROM app.OrderAssignments WHERE HostUUID = '${hostUuid}' AND ${driversColumns().driverUser} = '${driverUuid}' AND Active = 1 ORDER BY AssignmentDate DESC, Updated DESC`,
      );
      expect(me.hostDataAvailable, 'hostDataAvailable').toBe(true);
      expect(me.host?.hostUuid.toLowerCase()).toBe(hostUuid);
      const [vendor, truck] = (latest ?? '|').split('|');
      expect(me.host?.vendor ?? '', 'the as-hauled vendor').toBe(vendor);
      if (truck) expect(me.host?.truck, 'the as-hauled truck').toBe(truck);
    });

    test('TSUB-16 while a load is running the host refuses to cancel it or move it to another driver with the End Haul message, and nothing changes', async () => {
      await offerAcceptBegin(second, assignment({ orderId: orders.second, loadsAssigned: 1, notes: `${MARKER} dh21` }));
      const version = driversAssignment(second.uuid, 'Status, Version');

      const canceled = await host.setStatus(second.id, 'Canceled', `${MARKER} cancel`);
      expect(canceled.status()).toBe(400);
      expect(await canceled.text()).toContain(RUNNING_HAUL);

      const moved = await assignments.update(
        second.id,
        assignment({ orderId: orders.second, loadsAssigned: 1, truckId: SECOND_TRUCK_ID, driverUserId: SECOND_DRIVER_ID, notes: `${MARKER} dh21` }),
      );
      expect(moved.status).toBe(400);
      expect(moved.text).toContain(RUNNING_HAUL);

      expect(hostStatus(second.id), 'the host assignment stays Running').toBe(4);
      expect(hostValue(`SELECT DriverUserID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${second.id}`), 'the driver is unchanged').toBe(driverId);
      await expect.poll(queuesDrained, { message: 'both queues settle', ...QUEUE }).toBe(true);
      expect(driversAssignment(second.uuid, 'Status, Version'), 'DRIVERS is unchanged').toBe(version);
    });

    test('TSUB-17 after End Haul the cancel goes through, DRIVERS keeps the row as Canceled, and a ticket upload to its trip is 409', async () => {
      expect(second.tripUuid, 'TSUB-16 began a load').not.toBe('');
      const ended = await driver.endHaul(second.tripUuid);
      expect(ended.status(), await ended.text()).toBe(202);
      await expect
        .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${second.tripUuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE })
        .toBe(30);

      const canceled = await host.setStatus(second.id, 'Canceled', `${MARKER} cancel`);
      expect(canceled.status(), await canceled.text()).toBe(200);
      await expect.poll(() => driversAssignment(second.uuid, 'Status'), { message: 'JobCanceled sets DRIVERS Canceled', ...QUEUE }).toBe('8');
      expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${second.uuid}'`), 'the canceled row is kept').toBe(1);

      const upload = await driver.upload(second.tripUuid, ticketFile(photo));
      expect(upload.status(), await upload.text()).toBe(409);
      expect(driversNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TripUUID = '${second.tripUuid}'`), 'no DRIVERS ticket').toBe(0);
    });

    test('TSUB-18 an untagged point without HostUUID is 202 (not 400), lands in DRIVERS, and its host copy is attached to the Running assignment for host-today', async () => {
      expect(work.id, 'TSUB-01 made the assignment').toBeGreaterThan(0);
      const chosen = driversValue(
        `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE ${driversColumns().driverUser} = '${driverUuid}' AND HostUUID = '${hostUuid}' AND Active = 1 AND Status IN (2, 4) AND AssignmentDate = '${hostToday()}' ORDER BY CASE WHEN Status = 4 THEN 0 ELSE 1 END`,
      );
      test.skip(!chosen, 'The driver has no Accepted or Running assignment for host-today in DRIVERS.');
      const chosenId = hostNumber(`SELECT OrderAssignmentID FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${chosen}'`);
      const ping: GpsPing = { TripGpsUUID: randomUUID(), lat: 29.995, lng: -97.88, isMoving: false, isManual: true, recordedAt: secondsAgo(5) };

      const sent = await driver.gpsPings([ping], DEVICE);
      expect(sent.status(), await sent.text()).toBe(202);
      expect(driversGps(ping.TripGpsUUID!), 'stored with no host, assignment or trip, not flagged, and sent').toBe('1||||0|-|1');
      expect(driversNumber(`SELECT CAST(IsManual AS int) FROM app.TripGps WHERE TripGpsUUID = '${ping.TripGpsUUID}'`), 'isManual is kept').toBe(1);
      await expect
        .poll(() => hostGps(ping.TripGpsUUID!), { message: 'the host copy is attached to that assignment, with no trip', ...QUEUE })
        .toBe(`1|${chosenId}|0`);
    });
    test('TSUB-20 a photo whose SHA-256 does not match comes back ImageSaved false: DRIVERS sends it again with a new link, at most three times, and does not mark it received', async () => {
      test.setTimeout(150_000);
      const badHash = { id: 0, uuid: '', tripUuid: '' };
      await offerAcceptBegin(badHash, assignment({ orderId: orders.work, loadsAssigned: 1, notes: `${MARKER} bad hash` }));
      const ended = await driver.endHaul(badHash.tripUuid);
      expect(ended.status(), await ended.text()).toBe(202);

      const ticketUuid = randomUUID();
      const badPhoto = Buffer.concat([photo, Buffer.from(`${MARKER} bad hash ${Date.now()}`)]);
      const uploaded = await driver.upload(badHash.tripUuid, ticketFile(badPhoto), { ticketUuid });
      expect(uploaded.status(), await uploaded.text()).toBe(202);
      await expect.poll(() => readDone(ticketUuid), { message: 'the reader finishes', timeout: 90_000, intervals: [2_000] }).toBe(true);

      driversNumber(`UPDATE app.Tickets SET ImageSha256 = REPLICATE('0', 64) WHERE TicketUUID = '${ticketUuid}'; SELECT @@ROWCOUNT`);
      const sent = await driver.submit(badHash.tripUuid, { ...submitted, ticketNumber: `${submitted.ticketNumber}-H` });
      expect(sent.status(), await sent.text()).toBe(202);

      await expect
        .poll(() => driversTicket(ticketUuid, 'SendCount'), { message: 'each ImageSaved false sends it again, up to three sends', ...RECEIVED })
        .toBe('3');
      await waitForQueues();
      expect(driversTicket(ticketUuid, `Status, CASE WHEN ReceivedAt IS NULL THEN 'waiting' ELSE 'received' END, SendCount`), 'still waiting after the third send').toBe(
        '40|waiting|3',
      );
    });

    test('TSUB-19 nothing this run sent ended in either dead-letter table, and both outboxes drain to zero', async () => {
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
