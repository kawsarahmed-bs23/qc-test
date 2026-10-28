import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../fixtures/test';
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
} from '../fixtures/localDb';
import { driverWorkRoutes, DriversMirrorApi, HostApi, type MirrorAssignment } from '../pages/DriversMirrorApi';
import { isDriversApiReachable, PasswordGrantApi } from '../pages/PasswordGrantApi';
import { env } from '../config/environment';

const DRIVER_EMAIL = 'e2e.qc825.driver@quarryconnect.test';
const DISPATCHER_EMAIL = 'e2e.qc825.dispatcher@quarryconnect.test';
const SECOND_DRIVER_EMAIL = 'e2e.qc825.driver2@quarryconnect.test';
const MARKER = 'e2e-qc825';
const RESYNC_WINDOW = 150_000;
const SNAPSHOT_WINDOW = 30_000;
const POLL = { intervals: [500, 1_000, 2_000] };
const TICKET_JPEG = path.resolve(__dirname, '..', 'fixtures', 'qc803', 'logo-solid.jpg');
const DRIVERS_API_SETTINGS = path.resolve(__dirname, '..', '..', 'quarryconnect-drivers-api', 'QuarryConnect.Drivers.WebApi');

type Role = 'work' | 'tomorrow' | 'cancel' | 'refuse' | 'move';

interface Seeded {
  userId: string;
  secondDriverId: string;
  secondHostUuid: string;
  ids: Record<Role, number>;
  uuids: Record<Role, string>;
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

function driversValue(query: string): string | null {
  return queryDriversDb(query);
}

function driversNumber(query: string): number {
  return Number(queryDriversDb(query) ?? '0');
}

function existingThrowawayDrivers(): string {
  return (queryIdentityDb(`SELECT STRING_AGG(Id, ',') FROM Users WHERE NormalizedEmail LIKE N'E2E.QC825.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none';
}

function removeAll(userIds: string): void {
  runDriversSeedScript('drivers-qc825.remove.sql', { UserIds: userIds });
  runSeedScript('host-qc825.remove.sql');
  runIdentitySeedScript('identity-qc825.remove.sql');
}

const ASSIGNMENT_STATUSES = ['', 'pending', 'accepted', 'rejected', 'running', 'complete', 'noanswer', 'noshow', 'canceled', 'reassigned'];

function statusName(value: unknown): string {
  return typeof value === 'number' ? ASSIGNMENT_STATUSES[value] : String(value).toLowerCase().replace(/[-_\s]/g, '');
}

function hostStatus(id: number): number {
  return hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

function latestCommand(userId: string, target: string, type: string): string | null {
  return driversValue(
    `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), CommandUUID)) FROM app.DriverCommands WHERE UserID_FK = ${sqlText(userId)} AND TargetUUID = '${target}' AND CommandType = ${sqlText(type)} ORDER BY DriverCommandID DESC`,
  );
}

test.describe('Drivers API serves driver work from the DRIVERS mirror (QC-825)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway driver copies that password.');
  test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

  let seeded: Seeded;
  let api: DriversMirrorApi;
  let secondApi: DriversMirrorApi;
  let hostUuid = '';
  let tripUuid = '';
  let originalDispatchEnabled: string | null = null;
  let runStartedAt = '';

  test.beforeAll(async ({ playwright, targetHost }) => {
    test.setTimeout(120_000);
    hostUuid = targetHost.uuid;
    removeAll(existingThrowawayDrivers());
    runStartedAt = hostValue(`SELECT CONVERT(varchar(23), GETUTCDATE(), 121)`)!;

    runIdentitySeedScript('identity-qc825-user.apply.sql', { Email: DRIVER_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-825 Driver' });
    const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER_EMAIL)})`);
    expect(userId, 'the throwaway Identity driver exists').not.toBeNull();

    runSeedScript('host-qc825-driver.apply.sql', { UserId: userId!, Email: DRIVER_EMAIL, IdentityDb: env.identitySql!.database });
    const ids = {} as Record<Role, number>;
    const uuids = {} as Record<Role, string>;
    for (const role of ['work', 'tomorrow', 'cancel', 'refuse', 'move'] as Role[]) {
      const where = `DriverUserID_FK = ${sqlText(userId!)} AND Notes = N'${MARKER} ${role}'`;
      ids[role] = hostNumber(`SELECT OrderAssignmentID FROM app.OrderAssignments WHERE ${where}`);
      uuids[role] = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE ${where}`)!;
      expect(ids[role], `seeded ${role} assignment`).toBeGreaterThan(0);
    }

    const secondHostUuid = randomUUID();
    runDriversSeedScript('drivers-qc825.apply.sql', { UserId: userId!, HostUuid: hostUuid, SecondHostUuid: secondHostUuid });
    originalDispatchEnabled = driversValue(`SELECT CAST(DispatchEnabled AS int) FROM app.Hosts WHERE HostUUID = '${hostUuid}'`);

    runIdentitySeedScript('identity-qc825-user.apply.sql', { Email: SECOND_DRIVER_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-825 Second driver' });
    const secondDriverId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(${sqlText(SECOND_DRIVER_EMAIL)})`);
    expect(secondDriverId, 'the second throwaway Identity driver exists').not.toBeNull();
    runSeedScript('host-qc825-driver2.apply.sql', { UserId: secondDriverId!, Email: SECOND_DRIVER_EMAIL, IdentityDb: env.identitySql!.database });
    runDriversSeedScript('drivers-qc825-link.apply.sql', { UserId: secondDriverId!, HostUuid: hostUuid });
    seeded = { userId: userId!, secondDriverId: secondDriverId!, secondHostUuid, ids, uuids };

    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const token = await new PasswordGrantApi(request).passwordGrant(DRIVER_EMAIL, env.admin!.password);
      expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
      api = new DriversMirrorApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), token.body.access_token!);
      const secondToken = await new PasswordGrantApi(request).passwordGrant(SECOND_DRIVER_EMAIL, env.admin!.password);
      expect(secondToken.status, `password grant: ${secondToken.body.error ?? ''} ${secondToken.body.error_description ?? ''}`).toBe(200);
      secondApi = new DriversMirrorApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), secondToken.body.access_token!);
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(async () => {
    if (seeded?.userId) {
      for (let wait = 0; wait < 30 && driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserID_FK IN (${sqlText(seeded.userId)}, ${sqlText(seeded.secondDriverId)}) AND Status = 10`) > 0; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (originalDispatchEnabled !== null) {
      queryDriversDb(`UPDATE app.Hosts SET DispatchEnabled = ${originalDispatchEnabled} WHERE HostUUID = '${hostUuid}' AND DispatchEnabled <> ${originalDispatchEnabled}`);
    }
    removeAll(seeded ? `${seeded.userId},${seeded.secondDriverId}` : existingThrowawayDrivers());
  });

  test('DMIR-01 linking a driver fills the mirror, and my-assignments returns what the host itself returns for that driver (AC8, AC9)', async ({ request }) => {
    test.setTimeout(RESYNC_WINDOW + 60_000);

    await expect
      .poll(async () => (await api.assignments(hostUuid)).map((a) => a.orderAssignmentUuid).sort(), {
        message: 'the resync sweep asks the host for the new link and its snapshots reach DRIVERS',
        timeout: RESYNC_WINDOW,
        intervals: [2_000, 5_000],
      })
      .toEqual([seeded.uuids.work, seeded.uuids.cancel, seeded.uuids.refuse, seeded.uuids.move].sort());
    expect(driversValue(`SELECT CASE WHEN SyncedAt IS NULL THEN 0 ELSE 1 END FROM app.DriverHostLinks l JOIN app.Hosts h ON h.HostID = l.HostID_FK WHERE l.UserID_FK = ${sqlText(seeded.userId)} AND h.HostUUID = '${hostUuid}'`)).toBe('1');
    expect(hostNumber(`SELECT COUNT(*) FROM app.DriverMirrorSubscriptions WHERE UserID_FK = ${sqlText(seeded.userId)} AND Active = 1`), 'the host subscribed the driver').toBe(1);

    const tomorrow = hostValue(`SELECT CONVERT(nvarchar(10), AssignmentDate, 23) FROM app.OrderAssignments WHERE OrderAssignmentID = ${seeded.ids.tomorrow}`)!;
    expect((await api.assignments(hostUuid, { from: tomorrow, to: tomorrow })).map((a) => a.orderAssignmentUuid)).toEqual([seeded.uuids.tomorrow]);

    const mirrored = (await api.assignments(hostUuid)).find((a) => a.orderAssignmentUuid === seeded.uuids.work)!;
    expect(mirrored).toMatchObject({ status: 'pending', pending: false, pendingAction: null, lastCommandError: null, completedTripCount: 0, openTrip: null });

    const host = new HostApi(request);
    expect(await host.signIn(DRIVER_EMAIL, env.admin!.password), 'the driver signs in to the host API').toBe(200);
    const hostResponse = await host.driverAssignments();
    expect(hostResponse.status(), 'the host endpoint still answers').toBe(200);
    const hostRows = (await hostResponse.json()).data.data as Record<string, unknown>[];
    const own = hostRows.find((row) => row.orderAssignmentId === seeded.ids.work);
    expect(own, 'the host lists the work assignment by its int id').toBeDefined();
    expect(own, 'the host shape is unchanged: no mirror fields').not.toHaveProperty('pending');
    expect(own).not.toHaveProperty('orderAssignmentUuid');

    for (const field of ['jobDocNameWithPrefix', 'origin', 'destination', 'materialName', 'assignmentDate', 'timeWindowStart', 'timeWindowEnd', 'loadsAssigned', 'completedTripCount', 'notes'] as const) {
      expect(mirrored[field as keyof MirrorAssignment], `${field} matches the host`).toEqual(own![field]);
    }
    expect(statusName(mirrored.status), 'status matches the host').toBe(statusName(own!.status));
  });

  test('DMIR-02 a second linked host shows none of the first host\'s work, and nothing is merged', async () => {
    const second = await api.myAssignments(seeded.secondHostUuid);
    expect(second.status()).toBe(200);
    expect((await second.json()).data.data).toEqual([]);

    expect((await api.details(seeded.secondHostUuid, seeded.uuids.work)).status(), 'the first host\'s assignment is not found under the second host').toBe(404);
    expect((await api.threadList(seeded.secondHostUuid)).threads).toEqual([]);
    expect((await api.accept(seeded.secondHostUuid, seeded.uuids.work)).status(), 'a write under the second host does not reach the first host\'s work').toBe(404);

    const first = await api.assignments(hostUuid);
    expect(first.every((a) => Object.values(seeded.uuids).includes(a.orderAssignmentUuid)), 'the first host lists only its own work').toBe(true);
    expect(driversNumber(`SELECT COUNT(*) FROM app.MirrorAssignments WHERE UserID_FK = ${sqlText(seeded.userId)} AND HostID_FK = (SELECT HostID FROM app.Hosts WHERE HostUUID = '${seeded.secondHostUuid}')`)).toBe(0);
  });

  test('DMIR-03 every driver-work route is a bare 404 while the host\'s dispatch is off, and 403 without a linked host', async () => {
    const routes = driverWorkRoutes({ orderAssignmentUuid: seeded.uuids.work, tripUuid: randomUUID() });

    for (const route of routes) {
      expect((await api.send(null, route)).status(), `${route.method} ${route.path} with no host`).toBe(403);
      expect((await api.send(randomUUID(), route)).status(), `${route.method} ${route.path} for an unlinked host`).toBe(403);
    }

    expect(originalDispatchEnabled).toBe('1');
    try {
      queryDriversDb(`UPDATE app.Hosts SET DispatchEnabled = 0 WHERE HostUUID = '${hostUuid}'`);
      for (const route of routes) {
        const response = await api.send(hostUuid, route);
        expect(response.status(), `${route.method} ${route.path} while dispatch is off`).toBe(404);
        const body = (await response.text()).trim();
        expect(body, `${route.method} ${route.path} says nothing about dispatch`).not.toMatch(/dispatch|feature/i);
        if (body) {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          expect(parsed, `${route.method} ${route.path} returns no data`).not.toHaveProperty('data');
          expect(parsed.status ?? 404, `${route.method} ${route.path} is a plain Not Found`).toBe(404);
        }
      }
    } finally {
      queryDriversDb(`UPDATE app.Hosts SET DispatchEnabled = ${originalDispatchEnabled} WHERE HostUUID = '${hostUuid}'`);
    }
    expect(driversValue(`SELECT CAST(DispatchEnabled AS int) FROM app.Hosts WHERE HostUUID = '${hostUuid}'`)).toBe(originalDispatchEnabled);
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserID_FK = ${sqlText(seeded.userId)}`), 'no route sent anything to a host').toBe(0);
    expect((await api.myAssignments(hostUuid)).status()).toBe(200);
  });

  test('DMIR-04 a dispatcher change on the host reaches my-assignments', async () => {
    hostValue(`UPDATE app.OrderAssignments SET OrderAssignmentStatusID_FK = 8, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.cancel}`);

    await expect
      .poll(async () => (await api.assignments(hostUuid)).find((a) => a.orderAssignmentUuid === seeded.uuids.cancel)?.status, {
        message: 'the host trigger and drain send the canceled assignment to DRIVERS',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe('canceled');
  });

  test('DMIR-05 accepting a job answers 202 pending, the host accepts it once, and the mirror clears pending', async () => {
    const response = await api.accept(hostUuid, seeded.uuids.work);
    expect(response.status()).toBe(202);
    const optimistic = (await response.json()).data as MirrorAssignment;
    expect(optimistic).toMatchObject({ orderAssignmentUuid: seeded.uuids.work, status: 'accepted', pending: true });
    expect(optimistic.pendingAction).toBeTruthy();

    await expect.poll(() => hostStatus(seeded.ids.work), { message: 'the host OrderAssignment becomes Accepted', timeout: SNAPSHOT_WINDOW, ...POLL }).toBe(2);
    const command = latestCommand(seeded.userId, seeded.uuids.work, 'accept-assignment');
    expect(command, 'DRIVERS recorded the command').not.toBeNull();
    expect(hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(CAST(Accepted AS int))) FROM app.DriverCommandReceipts WHERE CommandUUID = '${command}'`), 'one accepted receipt on the host').toBe('1:1');

    await expect
      .poll(async () => {
        const row = await api.assignment(hostUuid, seeded.uuids.work);
        return row && { status: row.status, pending: row.pending, lastCommandError: row.lastCommandError };
      }, { message: 'the mirror confirms the accept', timeout: SNAPSHOT_WINDOW, ...POLL })
      .toEqual({ status: 'accepted', pending: false, lastCommandError: null });
  });

  test('DMIR-06 begin-haul makes the host trip with the same TripUUID, pings reach TripGps, and end-haul completes it', async () => {
    const begin = await api.beginHaul(hostUuid, seeded.uuids.work);
    expect(begin.status()).toBe(202);
    const trip = (await begin.json()).data;
    expect(trip).toMatchObject({ orderAssignmentUuid: seeded.uuids.work, status: 'active', pending: true });
    tripUuid = String(trip.tripUuid).toLowerCase();

    await expect
      .poll(() => hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(Status)) FROM app.Trips WHERE TripUUID = '${tripUuid}' AND OrderAssignmentID_FK = ${seeded.ids.work}`), {
        message: 'the host has exactly one active trip with the mirror\'s TripUUID',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe('1:20');
    await expect.poll(() => hostStatus(seeded.ids.work), { message: 'the host assignment is Running', timeout: SNAPSHOT_WINDOW, ...POLL }).toBe(4);
    await expect
      .poll(async () => (await api.assignment(hostUuid, seeded.uuids.work))?.trips?.find((t) => t.tripUuid === tripUuid)?.pending, { timeout: SNAPSHOT_WINDOW, ...POLL })
      .toBe(false);

    const now = Date.now();
    const pings = [0, 1].map((i) => ({
      lat: 30.2672 + i / 1000,
      lng: -97.7431,
      accuracyMeters: 5,
      isMoving: true,
      recordedAt: new Date(Math.floor((now - (2 - i) * 15_000) / 1_000) * 1_000 + [125, 455][i]).toISOString(),
      tripUuid,
      orderAssignmentUuid: seeded.uuids.work,
    }));
    const pinged = await api.pings(hostUuid, pings, 'e2e-qc825-device');
    expect(pinged.status()).toBe(202);
    expect((await pinged.json()).data).toMatchObject({ accepted: 2 });
    expect(Number((await (await api.pings(hostUuid, pings, 'e2e-qc825-device')).json()).data.nextIntervalSeconds)).toBeGreaterThan(0);
    await expect
      .poll(() => hostNumber(`SELECT COUNT(*) FROM app.TripGps g JOIN app.Trips t ON t.TripID = g.TripID_FK WHERE t.TripUUID = '${tripUuid}'`), {
        message: 'the pings are stored once on the host trip (the repeat batch is a duplicate)',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe(2);

    const end = await api.endHaul(hostUuid, tripUuid);
    expect(end.status()).toBe(202);
    expect((await end.json()).data).toMatchObject({ tripUuid, status: 'complete', pending: true });
    await expect
      .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`), { message: 'the host trip is Complete', timeout: SNAPSHOT_WINDOW, ...POLL })
      .toBe(30);
    await expect
      .poll(async () => {
        const row = (await api.assignment(hostUuid, seeded.uuids.work))?.trips?.find((t) => t.tripUuid === tripUuid);
        return row && { status: row.status, pending: row.pending, lastCommandError: row.lastCommandError };
      }, { timeout: SNAPSHOT_WINDOW, ...POLL })
      .toEqual({ status: 'complete', pending: false, lastCommandError: null });
  });

  test('DMIR-07 the dispatch thread is marked seen on the host, and a driver message lands on the host with the same MessageUUID', async () => {
    const seededMessage = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), MessageUUID)) FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.ids.work} AND Direction = 20`)!;
    const list = await api.threadList(hostUuid);
    expect(list.driverName).toBeTruthy();
    expect(list.threads.find((t) => t.orderAssignmentUuid === seeded.uuids.work)).toMatchObject({ unseenCount: 1 });

    const seen = await api.markSeen(hostUuid, seeded.uuids.work);
    expect(seen.status()).toBe(202);
    expect((await seen.json()).data).toMatchObject({ marked: 1 });
    await expect
      .poll(() => hostValue(`SELECT CASE WHEN SeenByDriverAt IS NULL THEN 0 ELSE 1 END FROM app.Messages WHERE MessageUUID = '${seededMessage}'`), {
        message: 'the host marks the dispatch message seen by the driver',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe('1');

    const body = `e2e-qc825 driver reply ${Date.now()}`;
    const sent = await api.sendMessage(hostUuid, seeded.uuids.work, body);
    expect(sent.status()).toBe(202);
    const message = (await sent.json()).data;
    expect(message).toMatchObject({ orderAssignmentUuid: seeded.uuids.work, isFromDispatch: false, messageBody: body, pending: true });
    const messageUuid = String(message.messageUuid).toLowerCase();

    await expect
      .poll(() => hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(Direction), ':', MIN(DriverUserID_FK)) FROM app.Messages WHERE MessageUUID = '${messageUuid}' AND OrderAssignmentID_FK = ${seeded.ids.work}`), {
        message: 'the host stores the driver message once, inbound, with the mirror\'s MessageUUID',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe(`1:10:${seeded.userId}`);
    await expect
      .poll(async () => {
        const thread = await api.thread(hostUuid, seeded.uuids.work);
        const messages = ((await thread.json()).data?.messages ?? []) as { messageUuid: string; pending: boolean }[];
        return messages.find((m) => m.messageUuid.toLowerCase() === messageUuid)?.pending;
      }, { timeout: SNAPSHOT_WINDOW, ...POLL })
      .toBe(false);

    const replies = await api.quickReplies(hostUuid);
    expect(replies.status()).toBe(200);
    expect(((await replies.json()).data.data as { keyword: string }[]).map((r) => r.keyword)).toContain('READY');
  });

  test('DMIR-08 a change the host refuses shows lastCommandError and the mirror goes back to the host value', async () => {
    const commandsBefore = driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserID_FK = ${sqlText(seeded.userId)}`);
    const tooEarly = await api.beginHaul(hostUuid, seeded.uuids.tomorrow);
    expect(tooEarly.status(), 'a load on tomorrow\'s job is refused by the Drivers API itself').toBe(400);
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserID_FK = ${sqlText(seeded.userId)}`), 'nothing was sent to the host').toBe(commandsBefore);

    hostValue(
      `BEGIN TRANSACTION; UPDATE app.OrderAssignments SET OrderAssignmentStatusID_FK = 4, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.refuse}; ` +
        `UPDATE app.DriverMirrorChanges SET ProcessedAt = GETUTCDATE(), Updated = GETUTCDATE() WHERE UserID_FK = ${sqlText(seeded.userId)} AND ProcessedAt IS NULL; COMMIT TRANSACTION;`,
    );
    expect((await api.assignment(hostUuid, seeded.uuids.refuse))?.status, 'the mirror has not heard of the host change yet').toBe('pending');

    const response = await api.accept(hostUuid, seeded.uuids.refuse);
    expect(response.status(), 'the mirror allows the accept').toBe(202);
    expect((await response.json()).data).toMatchObject({ status: 'accepted', pending: true });
    const command = latestCommand(seeded.userId, seeded.uuids.refuse, 'accept-assignment');
    expect(command, 'DRIVERS recorded the accept').not.toBeNull();

    await expect
      .poll(async () => {
        const row = await api.assignment(hostUuid, seeded.uuids.refuse);
        return row && { status: row.status, pending: row.pending, refused: !!row.lastCommandError };
      }, { message: 'the refusal shows and the host snapshot restores Running', timeout: SNAPSHOT_WINDOW, ...POLL })
      .toEqual({ status: 'running', pending: false, refused: true });
    expect(hostStatus(seeded.ids.refuse), 'the host value is unchanged').toBe(4);
    expect(hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(CAST(Accepted AS int))) FROM app.DriverCommandReceipts WHERE CommandUUID = '${command}'`), 'one refused receipt on the host').toBe('1:0');
    expect(driversValue(`SELECT Status FROM app.DriverCommands WHERE CommandUUID = '${command}'`), 'DRIVERS marks the command rejected').toBe('30');
  });

  test('DMIR-09 a ticket photo goes to the host bucket and DRIVERS keeps only its key, never the bytes (AC7)', async () => {
    test.setTimeout(150_000);
    expect(tripUuid, 'DMIR-06 finished a load').not.toBe('');

    await expect
      .poll(() => driversValue(`SELECT CASE WHEN UploadUrl IS NULL THEN 0 ELSE 1 END FROM app.MirrorTrips WHERE TripUUID = '${tripUuid}'`), {
        message: 'the host snapshot carries an upload link for the finished load',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe('1');

    const file = { name: 'e2e-qc825-ticket.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(TICKET_JPEG) };
    let upload = await api.uploadTicket(hostUuid, tripUuid, file);
    for (let attempt = 0; upload.status() === 409 && attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      upload = await api.uploadTicket(hostUuid, tripUuid, file);
    }
    if (upload.status() === 502) {
      test.info().annotations.push({ type: 'skip', description: 'The local host S3 settings did not accept the presigned PUT (502); AC7 not verified.' });
      test.skip(true, 'The local host S3 bucket refused the upload (502).');
    }
    expect(upload.status()).toBe(202);
    expect((await upload.json()).data).toMatchObject({ tripUuid, pending: true });

    const key = driversValue(`SELECT ImageKey FROM app.MirrorTrips WHERE TripUUID = '${tripUuid}'`);
    expect(key, 'DRIVERS keeps the S3 key of the photo').toBeTruthy();
    test.info().annotations.push({ type: 's3-object', description: `Uploaded to the host bucket under ${key}` });
    expect(
      driversNumber(
        `SELECT COUNT(*) FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id JOIN sys.types ty ON ty.user_type_id = c.user_type_id ` +
          `WHERE SCHEMA_NAME(t.schema_id) = 'app' AND ty.name IN ('varbinary', 'image', 'binary') AND t.name NOT LIKE 'wolverine%'`,
      ),
      'no DRIVERS app table can hold image bytes',
    ).toBe(0);

    const command = latestCommand(seeded.userId, tripUuid, 'upload-ticket');
    expect(command, 'DRIVERS recorded the upload command').not.toBeNull();
    await expect
      .poll(() => hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID = '${command}'`), {
        message: 'the host handled the upload command once',
        timeout: 120_000,
        intervals: [2_000, 5_000],
      })
      .toBe(1);
  });

  test('DMIR-10 every command reached the host exactly once: one receipt per CommandUUID and one host row per trip and message', async () => {
    const commands = (driversValue(`SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), CommandUUID)), ',') FROM app.DriverCommands WHERE UserID_FK = ${sqlText(seeded.userId)}`) ?? '')
      .split(',')
      .filter(Boolean);
    expect(commands.length, 'the run sent commands').toBeGreaterThanOrEqual(5);

    const list = commands.map((c) => `'${c}'`).join(',');
    expect(hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID IN (${list})`), 'one receipt per command').toBe(commands.length);
    expect(hostNumber(`SELECT COUNT(*) FROM (SELECT CommandUUID FROM app.DriverCommandReceipts WHERE CommandUUID IN (${list}) GROUP BY CommandUUID HAVING COUNT(*) > 1) d`)).toBe(0);
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserID_FK = ${sqlText(seeded.userId)} AND Status = 10`), 'no command is still waiting').toBe(0);

    expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${seeded.ids.work}`), 'one host trip for the one begin-haul').toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.ids.work} AND Direction = 10`), 'one host message for the one send').toBe(1);
  });

  test('DMIR-11 DRIVERS holds no host primary keys and no connection to a host database (AC10)', async () => {
    const hostKeyColumns = driversValue(
      `SELECT STRING_AGG(t.name + '.' + c.name, ', ') FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id ` +
        `WHERE SCHEMA_NAME(t.schema_id) = 'app' AND (t.name LIKE 'Mirror%' OR t.name = 'DriverCommands') AND c.is_identity = 0 ` +
        `AND (c.name LIKE '%OrderAssignmentID%' OR c.name LIKE '%OrderID%' OR c.name LIKE '%TripID%' OR c.name LIKE '%TicketID%' OR c.name LIKE '%MessageID%' OR c.name LIKE '%JobID%' OR c.name LIKE '%VendorID%' OR c.name LIKE '%TruckID%')`,
    );
    expect(hostKeyColumns, 'mirror tables key host rows by UUID only').toBeNull();
    expect(driversNumber(`SELECT COUNT(*) FROM sys.synonyms`), 'no synonyms to another database').toBe(0);
    expect(driversNumber(`SELECT COUNT(*) FROM sys.sql_expression_dependencies WHERE referenced_database_name IS NOT NULL OR referenced_server_name IS NOT NULL`), 'no cross-database references').toBe(0);
    expect(driversNumber(`SELECT COUNT(*) FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id WHERE SCHEMA_NAME(t.schema_id) = 'app' AND c.name LIKE '%Connection%'`)).toBe(0);

    for (const file of ['appsettings.json', 'appsettings.Development.json']) {
      const full = path.join(DRIVERS_API_SETTINGS, file);
      test.skip(!fs.existsSync(full), `The drivers API source (${full}) is not next to this project.`);
      const settings = JSON.parse(fs.readFileSync(full, 'utf8').replace(/^﻿/, '')) as { ConnectionStrings?: Record<string, string> };
      expect(Object.keys(settings.ConnectionStrings ?? {}), `${file} has only the DRIVERS connection string`).toEqual(['Drivers']);
      expect(settings.ConnectionStrings!.Drivers, `${file} points at a drivers database`).toMatch(/Database=QuarryConnect_Drivers/i);
    }
  });

  test('DMIR-12 a dispatcher message sent through the host API is stored once and reaches the driver\'s thread', async ({ request }) => {
    if (hostNumber(`SELECT COUNT(*) FROM app.OrderAssignments WHERE DriverUserID_FK = ${sqlText(seeded.userId)} AND OrderAssignmentStatusID_FK = 4`) === 0) {
      hostValue(`UPDATE app.OrderAssignments SET OrderAssignmentStatusID_FK = 4, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.refuse}`);
    }
    const dispatcher = new HostApi(request);
    expect(await dispatcher.signIn(DISPATCHER_EMAIL, env.admin!.password), 'the throwaway dispatcher signs in to the host API').toBe(200);

    const body = `e2e-qc825 dispatch ${Date.now()}`;
    const sent = await dispatcher.sendDispatchMessage(seeded.userId, seeded.ids.work, body);
    expect(sent.status(), `the host stores the dispatch message through EF on a table with the QC-825 trigger: ${sent.status() === 200 ? '' : await sent.text()}`).toBe(200);
    const stored = `FROM app.Messages m JOIN app.OrderAssignments oa ON oa.OrderAssignmentID = m.OrderAssignmentID_FK WHERE m.DriverUserID_FK = ${sqlText(seeded.userId)} AND m.MessageBody = ${sqlText(body)} AND m.Direction = 20 AND m.Channel = 20`;
    expect(hostNumber(`SELECT COUNT(*) ${stored}`), "one outbound in-app message on one of the driver's assignments").toBe(1);
    const threadUuid = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), oa.OrderAssignmentUUID)) ${stored}`)!;
    expect(Object.values(seeded.uuids)).toContain(threadUuid);

    await expect
      .poll(async () => {
        const thread = await api.thread(hostUuid, threadUuid);
        const messages = ((await thread.json()).data?.messages ?? []) as { messageBody: string; isFromDispatch: boolean }[];
        return messages.filter((m) => m.messageBody === body).map((m) => m.isFromDispatch);
      }, { message: "the dispatch message reaches the driver's thread in DRIVERS", timeout: SNAPSHOT_WINDOW, ...POLL })
      .toEqual([true]);
  });

  test('DMIR-13 a link whose resync was asked for over 5 minutes ago and never answered is resynced again by the sweep', async () => {
    test.setTimeout(RESYNC_WINDOW + 30_000);
    const link = `FROM app.DriverHostLinks l JOIN app.Hosts h ON h.HostID = l.HostID_FK WHERE l.UserID_FK = ${sqlText(seeded.userId)} AND h.HostUUID = '${hostUuid}'`;
    queryDriversDb(`UPDATE l SET SyncRequestedAt = DATEADD(MINUTE, -6, GETUTCDATE()), SyncedAt = NULL ${link}`);
    const stuckAt = driversValue(`SELECT CONVERT(varchar(23), l.SyncRequestedAt, 121) ${link}`)!;

    await expect
      .poll(() => driversValue(`SELECT CASE WHEN l.SyncedAt IS NOT NULL AND l.SyncRequestedAt > '${stuckAt}' AND l.SyncedAt >= l.SyncRequestedAt THEN 1 ELSE 0 END ${link}`), {
        message: 'the sweep asks the host again and the host answers with a completed resync',
        timeout: RESYNC_WINDOW,
        intervals: [2_000, 5_000],
      })
      .toBe('1');
    expect((await api.assignments(hostUuid)).map((a) => a.orderAssignmentUuid), "the mirror still holds the driver's work").toContain(seeded.uuids.work);
  });

  test("DMIR-14 reassigning a job to another driver moves it and its thread from the first driver's mirror to the second's", async () => {
    test.setTimeout(RESYNC_WINDOW + 60_000);
    const moveBody = 'e2e-qc825 dispatch note: this job may move to another driver';
    await expect
      .poll(() => driversValue(`SELECT CASE WHEN l.SyncedAt IS NULL THEN 0 ELSE 1 END FROM app.DriverHostLinks l JOIN app.Hosts h ON h.HostID = l.HostID_FK WHERE l.UserID_FK = ${sqlText(seeded.secondDriverId)} AND h.HostUUID = '${hostUuid}'`), {
        message: 'the second driver is resynced, so the host has subscribed it',
        timeout: RESYNC_WINDOW,
        intervals: [2_000, 5_000],
      })
      .toBe('1');
    expect(await secondApi.assignments(hostUuid), 'the second driver starts with no work').toEqual([]);

    const threadBodies = async (driver: DriversMirrorApi) => {
      const thread = await driver.thread(hostUuid, seeded.uuids.move);
      return thread.status() === 200 ? (((await thread.json()).data?.messages ?? []) as { messageBody: string }[]).map((m) => m.messageBody) : [];
    };
    expect(await threadBodies(api), "the first driver has the job's thread").toContain(moveBody);

    const mirrorRow = () =>
      (driversValue(`SELECT STRING_AGG(CONCAT(UserID_FK, ' v', Version, ' s', Status), '; ') FROM app.MirrorAssignments WHERE OrderAssignmentUUID = '${seeded.uuids.move}'`) ?? 'none')
        .replace(seeded.userId, 'first')
        .replace(seeded.secondDriverId, 'second');
    const started = Date.now();
    const timeline = [`before: ${mirrorRow()}`];
    hostValue(`UPDATE app.OrderAssignments SET DriverUserID_FK = ${sqlText(seeded.secondDriverId)}, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.move}`);

    try {
      await expect
        .poll(async () => {
          const row = mirrorRow();
          if (timeline[timeline.length - 1].split(': ')[1] !== row) timeline.push(`+${Date.now() - started}ms: ${row}`);
          return {
          first: (await api.assignments(hostUuid)).some((a) => a.orderAssignmentUuid === seeded.uuids.move),
          second: (await secondApi.assignments(hostUuid)).map((a) => a.orderAssignmentUuid),
          secondThread: await threadBodies(secondApi),
          };
        }, { message: 'the job and its thread leave the first driver and reach the second', timeout: SNAPSHOT_WINDOW, ...POLL })
        .toEqual({ first: false, second: [seeded.uuids.move], secondThread: [moveBody] });
    } finally {
      const driverName = (id: string | null) => (id === seeded.userId ? 'first' : id === seeded.secondDriverId ? 'second' : id);
      const changes = (hostValue(
        `SELECT STRING_AGG(CONCAT(DriverMirrorChangeID, ':', UserID_FK, ':', ISNULL(CONVERT(varchar(10), MessageID_FK), '-'), ':', CASE WHEN ProcessedAt IS NULL THEN 'open' ELSE 'done' END), ';') FROM app.DriverMirrorChanges WHERE OrderAssignmentID_FK = ${seeded.ids.move}`,
      ) ?? '').split(';').filter(Boolean).map((c) => c.split(':')).map(([id, user, message, state]) => `${id}:${driverName(user)}:${message}:${state}`);
      test.info().annotations.push(
        { type: 'mirror-timeline', description: timeline.join(' -> ') },
        { type: 'host-changes', description: changes.join(' ') || 'none' },
        { type: 'host-subscribed-second', description: hostValue(`SELECT COUNT(*) FROM app.DriverMirrorSubscriptions WHERE UserID_FK = ${sqlText(seeded.secondDriverId)} AND Active = 1`) ?? '0' },
        { type: 'mirror-rows', description: driversValue(`SELECT STRING_AGG(CONCAT(UserID_FK, ' v', Version, ' ', Status), '; ') FROM app.MirrorAssignments WHERE OrderAssignmentUUID = '${seeded.uuids.move}'`)?.replace(seeded.userId, 'first').replace(seeded.secondDriverId, 'second') ?? 'none' },
      );
    }

    expect((await api.details(hostUuid, seeded.uuids.move)).status(), 'the first driver can no longer open the job').toBe(404);
    expect(driversValue(`SELECT STRING_AGG(UserID_FK, ',') FROM app.MirrorAssignments WHERE OrderAssignmentUUID = '${seeded.uuids.move}'`), 'one mirror row, owned by the second driver').toBe(seeded.secondDriverId);
    expect(driversValue(`SELECT STRING_AGG(m.UserID_FK, ',') FROM app.MirrorMessages m WHERE m.OrderAssignmentUUID = '${seeded.uuids.move}'`), 'the thread belongs to the second driver only').toBe(seeded.secondDriverId);
  });

  test('DMIR-15 nothing this run sent to the host ended in its dead letters, including a ping batch the phone sent twice', async () => {
    await expect
      .poll(() => hostValue(`SELECT STRING_AGG(CONCAT(message_type, ': ', LEFT(exception_message, 120)), ' | ') FROM wolverine.wolverine_dead_letters WHERE sent_at >= '${runStartedAt}'`), {
        message: 'no message this run sent to the host ended in its dead letters (a repeated ping batch must be dropped as duplicates, not fail)',
        timeout: 5_000,
      })
      .toBeNull();
  });
});
