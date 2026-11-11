import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, canUseDriversDb, driversColumns, queryDriversDb, querySingleValue, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { DriverEventsApi, HostDriverEventsApi } from '@api/driver-events.api';
import { HostAssignmentsApi, type AssignmentSave } from '@api/host-assignments.api';
import { isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { env, TEST_DATA_DIR } from '@config/env.config';

const MARKER = 'e2e-qc920';
const ORDER_ID = 26;
const JOB_EDIT_ORDER_ID = 25;
const VENDOR_ID = 34;
const TRUCK_ID = 38;
const SECOND_DRIVER_ID = '099d0449-2094-4323-a644-6a63c49ba30e';
const SECOND_TRUCK_ID = 43;
const QUEUE = { timeout: 20_000, intervals: [500, 1_000, 2_000] };
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');

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

function assignmentUuid(id: number): string {
  return hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`)!;
}

function hostStatus(id: number): number {
  return hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

function driversRow(uuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`);
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

function removeAll(): void {
  runDriversSeedScript('drivers-qc920.remove.sql');
  runSeedScript('host-qc920.remove.sql');
}

test.describe('Host and Drivers API exchange named Wolverine events instead of the driver mirror (QC-920)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseDriversDb(), 'Needs the host and DRIVERS local databases (local only).');
  test.skip(!env.appAdmin || !env.driver, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD and DRIVER_EMAIL / DRIVER_PASSWORD.');
  test.skip(!env.appApiUrl || !env.driversApiUrl, 'Needs APP_API_URL and DRIVERS_API_URL.');

  let host: HostDriverEventsApi;
  let assignments: HostAssignmentsApi;
  let driver: DriverEventsApi;
  let hostUuid = '';
  let driverId = '';
  let driverUuid = '';
  let deadLetters = { host: 0, drivers: 0 };
  const work = { id: 0, uuid: '', tripUuid: '' };
  const dispatch = { id: 0, uuid: '' };

  const assignment = (overrides: Partial<AssignmentSave>): AssignmentSave => ({
    orderId: ORDER_ID,
    assignmentDate: hostToday(),
    vendorId: VENDOR_ID,
    truckId: TRUCK_ID,
    driverUserId: driverId,
    truckCount: null,
    loadsAssigned: 2,
    notes: MARKER,
    ...overrides,
  });

  test.beforeAll(async ({ playwright, targetHost }) => {
    test.setTimeout(90_000);
    hostUuid = targetHost.uuid;
    test.skip(
      driversNumber(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`) === 0,
      `The host '${targetHost.name}' (HOST_NAME) is not an active host in DRIVERS.`,
    );
    test.skip(
      hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE OrderID IN (${ORDER_ID}, ${JOB_EDIT_ORDER_ID})`) < 2 ||
        hostNumber(`SELECT COUNT(*) FROM auth.Users WHERE Id = ${sqlText(SECOND_DRIVER_ID)}`) === 0,
      `Needs orders ${ORDER_ID} and ${JOB_EDIT_ORDER_ID} and the second driver of the local copy.`,
    );

    const probe = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(probe)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const token = await new PasswordGrantApi(probe).passwordGrant(env.driver!.email, env.driver!.password);
      expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
      driverUuid = tokenSubject(token.body.access_token!);
      driver = new DriverEventsApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), token.body.access_token!);
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

    removeAll();
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

  test('DEVT-01 a dispatcher assigning a linked driver sends JobOffered, and DRIVERS gets the assignment as Pending for that driver', async () => {
    const created = await assignments.create(assignment({ notes: `${MARKER} work` }));
    expect(created.status, created.text).toBe(201);
    work.id = Number(created.data);
    work.uuid = assignmentUuid(work.id);
    expect(work.uuid).toMatch(/^[0-9a-f-]{36}$/);

    await expect
      .poll(() => driversRow(work.uuid, `Status, ${driversColumns().text(driversColumns().driverUser)}`), { message: 'JobOffered reaches DRIVERS', ...QUEUE })
      .toBe(`1|${driverUuid}`);
    const jobId = hostNumber(`SELECT JobID_FK FROM app.Orders WHERE OrderID = ${ORDER_ID}`);
    expect(driversValue(`SELECT JobDocNameWithPrefix FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${work.uuid}'`), 'the job doc name').toMatch(
      new RegExp(`0*${jobId}$`),
    );
    expect(driversValue(`SELECT TruckNumber FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${work.uuid}'`), 'the truck number').toBeTruthy();
    expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${work.uuid}'`), 'one DRIVERS row').toBe(1);
  });

  test('DEVT-02 the driver accepting in the Drivers API answers 202 and JobAccepted makes the host assignment Accepted', async () => {
    expect(work.uuid, 'DEVT-01 created the assignment').not.toBe('');
    const accepted = await driver.accept(work.uuid);
    expect(accepted.status(), await accepted.text()).toBe(202);
    expect(driversRow(work.uuid, 'Status'), 'DRIVERS is final at once').toBe('2');
    await expect.poll(() => hostStatus(work.id), { message: 'JobAccepted reaches the host', ...QUEUE }).toBe(2);
  });

  test('DEVT-03 begin-haul with a client TripUUID makes the host trip with that TripUUID and its truck number, and the assignment Running', async () => {
    work.tripUuid = randomUUID();
    const begun = await driver.beginHaulWithTrip(work.uuid, work.tripUuid);
    expect(begun.status(), await begun.text()).toBe(202);
    expect(String((await begun.json()).data?.tripUuid ?? '').toLowerCase(), 'the Drivers API keeps the client TripUUID').toBe(work.tripUuid);

    await expect
      .poll(() => hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(OrderAssignmentID_FK)) FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), {
        message: 'TripStarted creates one host trip by TripUUID',
        ...QUEUE,
      })
      .toBe(`1:${work.id}`);
    await expect.poll(() => hostStatus(work.id), { message: 'the host assignment is Running', ...QUEUE }).toBe(4);
    const truckNumber = driversValue(`SELECT TruckNumber FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${work.uuid}'`);
    expect(hostValue(`SELECT TruckNumber FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), 'the host trip stores the truck number').toBe(truckNumber);
  });

  test('DEVT-04 three pings become three host TripGps rows with a TripGpsUUID, and the same batch again adds none', async () => {
    expect(work.tripUuid, 'DEVT-03 began a load').not.toBe('');
    const now = Date.now();
    const pings = [0, 1, 2].map((i) => ({
      lat: 29.989 + i / 1000,
      lng: -97.877,
      accuracyMeters: 5,
      isMoving: true,
      recordedAt: new Date(Math.floor((now - (30 - i * 10) * 1_000) / 1_000) * 1_000).toISOString(),
      tripUuid: work.tripUuid,
      orderAssignmentUuid: work.uuid,
    }));
    const gps = () =>
      hostValue(
        `SELECT CONCAT(COUNT(*), ':', SUM(CASE WHEN g.TripGpsUUID IS NULL THEN 1 ELSE 0 END)) FROM app.TripGps g JOIN app.Trips t ON t.TripID = g.TripID_FK WHERE t.TripUUID = '${work.tripUuid}'`,
      );

    const first = await driver.pings(pings, `${MARKER}-device`);
    expect(first.status(), await first.text()).toBe(202);
    await expect.poll(gps, { message: 'GpsTraceUploaded stores three points, each with a TripGpsUUID', ...QUEUE }).toBe('3:0');

    const again = await driver.pings(pings, `${MARKER}-device`);
    expect(again.status(), await again.text()).toBe(202);
    await expect.poll(queuesDrained, { message: 'both queues settle after the repeat batch', ...QUEUE }).toBe(true);
    expect(gps(), 'the repeat batch adds no point').toBe('3:0');
  });

  test('DEVT-05 end-haul makes the host trip Complete', async () => {
    expect(work.tripUuid, 'DEVT-03 began a load').not.toBe('');
    const ended = await driver.endHaul(work.tripUuid);
    expect(ended.status(), await ended.text()).toBe(202);
    await expect
      .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${work.tripUuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE })
      .toBe(30);
  });

  test('DEVT-06 a driver message lands on the host with its MessageUUID, and a dispatcher message lands in DRIVERS with the host MessageUUID', async () => {
    expect(work.uuid, 'DEVT-01 created the assignment').not.toBe('');
    const driverBody = `${MARKER} driver ${Date.now()}`;
    const sent = await driver.sendMessage(work.uuid, driverBody);
    expect(sent.status(), await sent.text()).toBe(202);
    const messageUuid = String((await sent.json()).data?.messageUuid ?? '').toLowerCase();
    expect(messageUuid).toMatch(/^[0-9a-f-]{36}$/);
    await expect
      .poll(
        () =>
          hostValue(
            `SELECT CONCAT(COUNT(*), ':', MIN(Direction), ':', MIN(OrderAssignmentID_FK)) FROM app.Messages WHERE MessageUUID = '${messageUuid}' AND MessageBody = ${sqlText(driverBody)}`,
          ),
        { message: 'DriverMessageSent stores one inbound host message with the same MessageUUID', ...QUEUE },
      )
      .toBe(`1:10:${work.id}`);

    const dispatchBody = `${MARKER} dispatch ${Date.now()}`;
    const dispatched = await host.sendDispatchMessage(driverId, work.id, dispatchBody);
    expect(dispatched.status(), await dispatched.text()).toBe(200);
    const hostMessageUuid = hostValue(
      `SELECT LOWER(CONVERT(nvarchar(36), MessageUUID)) FROM app.Messages WHERE OrderAssignmentID_FK = ${work.id} AND MessageBody = ${sqlText(dispatchBody)}`,
    );
    expect(hostMessageUuid, 'the host stored the dispatcher message').toMatch(/^[0-9a-f-]{36}$/);
    await expect
      .poll(
        () =>
          driversValue(
            `SELECT CONCAT(COUNT(*), ':', MIN(CAST(IsFromDispatch AS int)), ':', LOWER(CONVERT(nvarchar(36), MIN(OrderAssignmentUUID)))) FROM app.Messages WHERE MessageUUID = '${hostMessageUuid}'`,
          ),
        { message: 'MessageSent stores the dispatcher message in DRIVERS with the host MessageUUID', ...QUEUE },
      )
      .toBe(`1:1:${work.uuid}`);
  });

  test('DEVT-07 a time-window change on the host sends JobChanged, and DRIVERS gets the new start time', async () => {
    const created = await assignments.create(assignment({ assignmentDate: hostToday(1), loadsAssigned: 1, notes: `${MARKER} dispatch` }));
    expect(created.status, created.text).toBe(201);
    dispatch.id = Number(created.data);
    dispatch.uuid = assignmentUuid(dispatch.id);
    await expect
      .poll(() => driversRow(dispatch.uuid, `Status, ${driversColumns().text(driversColumns().driverUser)}`), {
        message: 'JobOffered reaches DRIVERS',
        ...QUEUE,
      })
      .toBe(`1|${driverUuid}`);
    const version = driversValue(`SELECT Version FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${dispatch.uuid}'`);

    const changed = await host.setTimeWindow(dispatch.id, '08:30', '15:00');
    expect(changed.status(), await changed.text()).toBe(200);
    await expect
      .poll(() => driversRow(dispatch.uuid, 'CONVERT(varchar(5), TimeWindowStart, 108), CONVERT(varchar(5), TimeWindowEnd, 108)'), {
        message: 'JobChanged updates the DRIVERS time window',
        ...QUEUE,
      })
      .toBe('08:30|15:00');
    expect(driversValue(`SELECT Version FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${dispatch.uuid}'`), 'the row version moved').not.toBe(version);
  });

  test('DEVT-08 request-location sends LocationRequested, and the driver gets an "asked for your location" dispatch message', async () => {
    expect(dispatch.uuid, 'DEVT-07 created the assignment').not.toBe('');
    const requested = await host.requestLocation(driverId, dispatch.id);
    expect(requested.status(), await requested.text()).toBe(200);
    await expect
      .poll(
        () =>
          driversValue(
            `SELECT CONCAT(COUNT(*), ':', MIN(CAST(IsFromDispatch AS int))) FROM app.Messages WHERE OrderAssignmentUUID = '${dispatch.uuid}' AND MessageBody LIKE N'%asked for your location%'`,
          ),
        { message: 'LocationRequested reaches DRIVERS as one dispatch message', ...QUEUE },
      )
      .toBe('1:1');
  });

  test('DEVT-09 reassigning moves the DRIVERS row to the new driver, and canceling sets it Canceled without deleting it', async () => {
    expect(dispatch.uuid, 'DEVT-07 created the assignment').not.toBe('');
    const secondUuid = (hostValue(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE Id = ${sqlText(SECOND_DRIVER_ID)}`) ?? '').toLowerCase();
    test.skip(
      driversNumber(
        `SELECT COUNT(*) FROM app.DriverHostLinks l JOIN app.Hosts h ON h.${driversColumns().hostKey} = l.${driversColumns().host} WHERE l.${driversColumns().user} = ${sqlText(secondUuid)} AND h.HostUUID = '${hostUuid}' AND l.Active = 1`,
      ) === 0,
      'The second driver is not linked to the host in DRIVERS.',
    );

    const moved = await assignments.update(
      dispatch.id,
      assignment({ assignmentDate: hostToday(1), loadsAssigned: 1, truckId: SECOND_TRUCK_ID, driverUserId: SECOND_DRIVER_ID, notes: `${MARKER} dispatch` }),
    );
    expect(moved.status, moved.text).toBe(200);
    await expect
      .poll(() => driversRow(dispatch.uuid, `Status, ${driversColumns().text(driversColumns().driverUser)}`), {
        message: 'JobCanceled to the first driver, then JobOffered to the second',
        ...QUEUE,
      })
      .toBe(`1|${secondUuid}`);
    expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${dispatch.uuid}'`), 'still one DRIVERS row').toBe(1);

    const canceled = await host.setStatus(dispatch.id, 'Canceled', `${MARKER} cancel`);
    expect(canceled.status(), await canceled.text()).toBe(200);
    await expect
      .poll(() => driversRow(dispatch.uuid, `Status, ${driversColumns().text(driversColumns().driverUser)}`), {
        message: 'JobCanceled sets DRIVERS Canceled',
        ...QUEUE,
      })
      .toBe(`8|${secondUuid}`);
    expect(driversNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${dispatch.uuid}'`), 'the canceled row is kept').toBe(1);
  });

  test('DEVT-10 saving a job the way the host UI does sends JobChanged inside the job transaction, so an unfinished assignment on it changes version in DRIVERS', async () => {
    test.fixme(
      hostNumber(`SELECT COUNT(*) FROM app.List_AddressTypes WHERE AddressTypeName = N'DeliverySite' AND Active = 1`) === 0,
      'The local host database has no DeliverySite row in app.List_AddressTypes, so every job save fails with "An address type is required." (JobModelFactory.CreateToAddressAsync); not caused by QC-920.',
    );
    const jobId = hostNumber(`SELECT JobID_FK FROM app.Orders WHERE OrderID = ${JOB_EDIT_ORDER_ID}`);
    const created = await assignments.create(
      assignment({ orderId: JOB_EDIT_ORDER_ID, assignmentDate: hostToday(1), loadsAssigned: 1, notes: `${MARKER} job edit` }),
    );
    expect(created.status, created.text).toBe(201);
    const uuid = assignmentUuid(Number(created.data));
    await expect.poll(() => driversRow(uuid, 'Status'), { message: 'JobOffered reaches DRIVERS', ...QUEUE }).toBe('1');
    const version = driversValue(`SELECT Version FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`);

    const saved = await host.saveJobAsTheUiDoes(await host.job(jobId));
    expect(saved.status(), await saved.text()).toBe(200);
    await expect
      .poll(() => driversValue(`SELECT Version FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`), {
        message: 'JobChanged reaches DRIVERS for the unfinished assignment',
        ...QUEUE,
      })
      .not.toBe(version);
  });

  test('DEVT-11 the host api/driver-sync is back for the Driver App until the Drivers API is ready (not 404), and the Drivers API answers 409 for the writes that wait on QC-873', async () => {
    expect(work.tripUuid, 'DEVT-03 began a load').not.toBe('');
    expect((await host.driverSync('GET')).status(), 'GET api/driver-sync').not.toBe(404);
    expect((await host.driverSync('POST')).status(), 'POST api/driver-sync').not.toBe(404);

    const trip = work.tripUuid;
    const file = { name: `${MARKER}-ticket.jpg`, mimeType: 'image/jpeg', buffer: fs.readFileSync(TICKET_JPEG) };
    const answers: Record<string, number> = {
      'reopen-haul': (await driver.reopenHaul(trip)).status(),
      'finish-day': (await driver.finishDay(work.uuid, MARKER)).status(),
      'report-problem': (await driver.reportProblem(trip, MARKER)).status(),
      reprocess: (await driver.reprocessTicket(trip)).status(),
      review: (await driver.reviewTicket(trip, { ticketNumber: '920', ticketDate: hostToday(), ticketQuantity: 1 })).status(),
      'threads seen': (await driver.markSeen(work.uuid)).status(),
      'ticket upload': (await driver.uploadTicket(trip, file)).status(),
    };
    expect(answers).toEqual({
      'reopen-haul': 409,
      'finish-day': 409,
      'report-problem': 409,
      reprocess: 409,
      review: 409,
      'threads seen': 409,
      'ticket upload': 409,
    });
    expect(hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${trip}'`), 'the host trip stays Complete').toBe(30);
    expect(hostStatus(work.id), 'the host assignment is unchanged').toBe(4);
  });

  test('DEVT-12 nothing this run sent ended in either dead-letter table, and the host outbox drains to zero', async () => {
    await expect.poll(() => hostNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`), { message: 'the host outbox drains', ...QUEUE }).toBe(0);
    await expect.poll(() => driversNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`), { message: 'the DRIVERS outbox drains', ...QUEUE }).toBe(0);
    expect(
      {
        host: hostNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
        drivers: driversNumber(`SELECT COUNT(*) FROM msg.wolverine_dead_letters`),
      },
      `dead letters before the run: host ${deadLetters.host}, drivers ${deadLetters.drivers}`,
    ).toEqual(deadLetters);
  });
});
