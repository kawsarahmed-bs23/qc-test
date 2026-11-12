import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@fixtures/pageFixtures';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseIdentityDb,
  driversColumns,
  queryDriversDb,
  queryIdentityDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';
import type { APIRequestContext } from '@playwright/test';
import { HostApi } from '@api/drivers-mirror.api';
import { HostAssignmentsApi } from '@api/host-assignments.api';
import { DriverSyncApi, ExpoStubLog, isReplayed, withCursor, type SyncPayload, type TicketFile } from '@api/driver-sync.api';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi, type TokenResponse } from '@api/password-grant.api';
import { env, TEST_DATA_DIR } from '@config/env.config';

const DRIVER_EMAIL = 'e2e.qc829.driver@quarryconnect.test';
const DISPATCHER_EMAIL = 'e2e.qc829.dispatcher@quarryconnect.test';
const SECOND_DRIVER_EMAIL = 'e2e.qc829.driver2@quarryconnect.test';
const MARKER = 'e2e-qc829';
const ACCESS_TOKEN_SECONDS = 1800;
const SNAPSHOT_WINDOW = 30_000;
const PUSH_SETTLE_MS = 8_000;
const POLL = { intervals: [500, 1_000, 2_000] };
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');

type Role = 'work' | 'tomorrow' | 'other' | 'gone' | 'move' | 'chat';
const ROLES: Role[] = ['work', 'tomorrow', 'other', 'gone', 'move', 'chat'];

interface Seeded {
  userId: string;
  secondDriverId: string;
  secondHostUuid: string;
  second: { accepted: string; pending: string };
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
  return (queryIdentityDb(`SELECT STRING_AGG(Id, ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC829.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none';
}

function removeAll(userIds: string): void {
  runDriversSeedScript('drivers-qc829.remove.sql', { UserIds: userIds });
  runSeedScript('host-qc829.remove.sql');
  runDriversSeedScript('drivers-qc829.remove.sql', { UserIds: userIds });
  runIdentitySeedScript('identity-qc829.remove.sql');
}

function hostStatus(id: number): number {
  return hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function uuidsOf(
  rows: { orderAssignmentUuid?: string; messageUuid?: string; tripUuid?: string }[],
  field: 'orderAssignmentUuid' | 'messageUuid' | 'tripUuid',
): string[] {
  return rows.map((row) => String(row[field]).toLowerCase()).sort();
}

function withoutCursor(payload: SyncPayload): Omit<SyncPayload, 'cursor'> {
  const { cursor: _cursor, ...rest } = payload;
  return rest;
}

test.describe('Drivers API local-first sync: delta reads, batched writes, idempotency and push (QC-829)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway driver copies that password.');
  test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

  let seeded: Seeded;
  let sync: DriverSyncApi;
  let issued: TokenResponse;
  let hostUuid = '';
  let settled = '';
  let tripUuid = '';
  const uploaded: Buffer | null = null;
  const uploadKey = '';

  const secondRows = () => (seeded.second.accepted ? [seeded.second.accepted, seeded.second.pending] : []);
  const allAssignments = () => [...ROLES.map((role) => seeded.uuids[role]), ...secondRows()].sort();

  const commands = (where = '') => driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE ${driversColumns().user} = ${sqlText(seeded.userId)} ${where}`);

  const settle = async (from: string): Promise<string> => {
    let cursor = from;
    await expect
      .poll(
        async () => {
          const delta = await sync.changes(cursor);
          const quiet = delta.assignments.length + delta.trips.length + delta.messages.length + delta.deleted.length === 0;
          cursor = delta.cursor;
          return quiet;
        },
        { message: 'the mirror stops changing for the driver', timeout: SNAPSHOT_WINDOW, ...POLL },
      )
      .toBe(true);
    return cursor;
  };

  const dispatch = async (request: APIRequestContext, role: Role, body: string) => {
    const dispatcher = new HostApi(request);
    expect(await dispatcher.signIn(DISPATCHER_EMAIL, env.admin!.password), 'the throwaway dispatcher signs in to the host API').toBe(200);
    const sent = await dispatcher.sendDispatchMessage(seeded.userId, seeded.ids[role], body);
    expect(sent.status(), `the host stores the dispatch message: ${sent.status() === 200 ? '' : await sent.text()}`).toBe(200);
    const stored = hostValue(
      `SELECT CONCAT(COUNT(*), '|', MIN(LOWER(CONVERT(nvarchar(36), m.MessageUUID))), '|', MIN(LOWER(CONVERT(nvarchar(36), oa.OrderAssignmentUUID)))) FROM app.Messages m JOIN app.OrderAssignments oa ON oa.OrderAssignmentID = m.OrderAssignmentID_FK WHERE m.MessageBody = ${sqlText(body)}`,
    )!;
    const [count, messageUuid, threadUuid] = stored.split('|');
    expect(count, `the host stored the dispatch message once (${stored})`).toBe('1');
    return { messageUuid, threadUuid };
  };

  const mirroredMessage = async (body: string) => {
    await expect
      .poll(
        () =>
          driversValue(
            `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), MessageUUID)), ',') FROM app.Messages WHERE MessageBody = ${sqlText(body)} AND ${driversColumns().driverUser} = ${sqlText(seeded.userId)}`,
          ),
        {
          message: 'MessageSent brings the dispatch message into DRIVERS',
          timeout: SNAPSHOT_WINDOW,
          ...POLL,
        },
      )
      .toBeTruthy();
  };

  test.beforeAll(async ({ playwright, targetHost }) => {
    test.setTimeout(120_000);
    hostUuid = targetHost.uuid;
    removeAll(existingThrowawayDrivers());

    runIdentitySeedScript('identity-qc829-user.apply.sql', { Email: DRIVER_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-829 Driver' });
    const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER_EMAIL)})`);
    expect(userId, 'the throwaway Identity driver exists').not.toBeNull();
    runSeedScript('host-qc829-driver.apply.sql', { UserId: userId!, Email: DRIVER_EMAIL, IdentityDb: env.identitySql!.database });

    const ids = {} as Record<Role, number>;
    const uuids = {} as Record<Role, string>;
    for (const role of ROLES) {
      const where = `DriverUserID_FK = ${sqlText(userId!)} AND Notes = N'${MARKER} ${role}'`;
      ids[role] = hostNumber(`SELECT OrderAssignmentID FROM app.OrderAssignments WHERE ${where}`);
      uuids[role] = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE ${where}`)!;
      expect(ids[role], `seeded ${role} assignment`).toBeGreaterThan(0);
    }

    runIdentitySeedScript('identity-qc829-user.apply.sql', { Email: SECOND_DRIVER_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-829 Second driver' });
    const secondDriverId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(SECOND_DRIVER_EMAIL)})`);
    expect(secondDriverId, 'the second throwaway Identity driver exists').not.toBeNull();
    runSeedScript('host-qc829-driver2.apply.sql', { UserId: secondDriverId!, Email: SECOND_DRIVER_EMAIL, IdentityDb: env.identitySql!.database });

    const secondHostUuid = randomUUID();
    runDriversSeedScript('drivers-qc829.apply.sql', { UserId: userId!, HostUuid: hostUuid, SecondHostUuid: secondHostUuid });
    const secondRow = (note: string) =>
      driversColumns().migrated
        ? (driversValue(
            `SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE ${driversColumns().driverUser} = ${sqlText(userId!)} AND Notes = N'${MARKER} ${note}'`,
          ) ?? '')
        : '';
    seeded = {
      userId: userId!,
      secondDriverId: secondDriverId!,
      secondHostUuid,
      second: { accepted: secondRow('second accepted'), pending: secondRow('second pending') },
      ids,
      uuids,
    };

    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const token = await new PasswordGrantApi(request).passwordGrant(DRIVER_EMAIL, env.admin!.password);
      expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
      issued = token.body;
      sync = new DriverSyncApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), issued.access_token!);
    } finally {
      await request.dispose();
    }

    hostValue(`UPDATE auth.Users SET UserUUID = Id WHERE Id IN (${sqlText(userId!)}, ${sqlText(secondDriverId!)}) AND UserUUID IS NULL`);
    const dispatcherContext = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const assigner = new HostAssignmentsApi(dispatcherContext);
      expect(await assigner.signIn(DISPATCHER_EMAIL, env.admin!.password), 'the throwaway dispatcher signs in to the host API').toBe(200);
      const truckId = hostNumber(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = ${sqlText(userId!)}`);
      const vendorId = hostNumber(`SELECT ParentOrganisationIdFk FROM auth.Organisations WHERE OrganisationId = ${truckId}`);
      for (const role of ROLES) {
        const sqlRow = `FROM app.OrderAssignments WHERE OrderAssignmentID = ${ids[role]}`;
        const created = await assigner.create({
          orderId: hostNumber(`SELECT OrderID_FK ${sqlRow}`),
          assignmentDate: hostValue(`SELECT CONVERT(nvarchar(10), AssignmentDate, 23) ${sqlRow}`)!,
          vendorId,
          truckId,
          driverUserId: userId!,
          truckCount: null,
          loadsAssigned: 2,
          notes: `${MARKER} ${role}`,
        });
        expect(created.status, `the host offers the ${role} job through its API: ${created.text}`).toBe(201);
        hostValue(
          `UPDATE app.OrderAssignments SET Active = 0, Notes = N'${MARKER} ${role} sql', Updated = GETUTCDATE() WHERE OrderAssignmentID = ${ids[role]}`,
        );
        ids[role] = Number(created.data);
        uuids[role] = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${ids[role]}`)!;
      }
      hostValue(`UPDATE app.OrderAssignments SET OrderAssignmentStatusID_FK = 4, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${ids.chat}`);
      const dispatcher = new HostApi(dispatcherContext);
      expect(await dispatcher.signIn(DISPATCHER_EMAIL, env.admin!.password)).toBe(200);
      const seededMessage = await dispatcher.sendDispatchMessage(userId!, ids.chat, `${MARKER} seeded dispatch message`);
      expect(seededMessage.status(), 'the host sends the first dispatch message (MessageSent)').toBe(200);
    } finally {
      await dispatcherContext.dispose();
    }
  });

  test.afterAll(async () => {
    if (seeded?.userId) {
      for (let wait = 0; wait < 30 && commands('AND Status = 10') > 0; wait++) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    removeAll(seeded ? `${seeded.userId},${seeded.secondDriverId}` : existingThrowawayDrivers());
  });

  test('SYNC-01 the first sync has no cursor, so it is a reset with every current row of the driver on every linked host (AC1, D66)', async () => {
    await expect
      .poll(
        () =>
          driversValue(
            `SELECT CONCAT((SELECT COUNT(*) FROM app.OrderAssignments WHERE ${driversColumns().driverUser} = ${sqlText(seeded.userId)}), ':', (SELECT COUNT(*) FROM app.Messages WHERE ${driversColumns().driverUser} = ${sqlText(seeded.userId)}))`,
          ),
        {
          message: 'QC-920: JobOffered and MessageSent bring the offered jobs and the dispatch message into DRIVERS',
          timeout: SNAPSHOT_WINDOW,
          ...POLL,
        },
      )
      .toBe(`${ROLES.length + secondRows().length}:1`);

    const first = await sync.changes();
    expect(first.reset).toBe(true);
    expect(first.cursor).toBeTruthy();
    expect(uuidsOf(first.assignments, 'orderAssignmentUuid')).toEqual(allAssignments());
    const seededMessages = (
      hostValue(
        `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), m.MessageUUID)), ',') FROM app.Messages m JOIN app.OrderAssignments oa ON oa.OrderAssignmentID = m.OrderAssignmentID_FK WHERE oa.DriverUserID_FK = ${sqlText(seeded.userId)} AND oa.Active = 1`,
      ) ?? ''
    )
      .split(',')
      .sort();
    expect(uuidsOf(first.messages, 'messageUuid'), 'the dispatch message the host sent').toEqual(seededMessages);
    expect(first.trips).toEqual([]);
    expect(first.deleted, 'a reset carries no tombstones').toEqual([]);
    const work = first.assignments.find((a) => a.orderAssignmentUuid === seeded.uuids.work)!;
    expect(work, 'assignment rows have the my-assignments shape').toMatchObject({ status: 'pending', pending: false, completedTripCount: 0 });
    expect(first.messages[0]).toHaveProperty('isFromDispatch', true);

    settled = await settle(first.cursor);
  });

  test('SYNC-02 replaying the same cursor twice with nothing changed in between returns the same empty delta (AC1)', async () => {
    const once = await sync.changes(settled);
    const twice = await sync.changes(settled);
    expect(withoutCursor(once)).toEqual({ reset: false, assignments: [], trips: [], messages: [], deleted: [] });
    expect(withoutCursor(twice)).toEqual(withoutCursor(once));
    expect(Buffer.from(twice.cursor, 'base64url').readBigInt64BE(0), 'the cursor does not move past rows it has not returned').toBe(
      Buffer.from(once.cursor, 'base64url').readBigInt64BE(0),
    );
  });

  test('SYNC-03 a malformed cursor is 400 on GET and POST, more than 50 operations is 400, and a per-host cursor from before one list or over 90 days old resets (AC1, D66)', async () => {
    for (const bad of ['not-a-cursor', 'AAAA', `${settled}AAAA`]) {
      const response = await sync.sync(bad);
      expect(response.status(), `GET /sync?since=${bad}`).toBe(400);
      expect((await response.json()).validationErrors, 'the error names since').toHaveProperty('since');
    }
    const badPost = await sync.push([], 'not-a-cursor');
    expect(badPost.status(), 'POST /sync with a malformed since').toBe(400);
    expect(JSON.stringify((await badPost.json()).validationErrors)).toMatch(/since/i);

    const before = commands();
    const tooMany = Array.from({ length: 51 }, () => ({ key: randomUUID(), type: 'mark-thread-seen', targetUuid: seeded.uuids.work }));
    expect((await sync.push(tooMany)).status(), '51 operations').toBe(400);
    expect(commands(), 'nothing was applied').toBe(before);

    const legacy = await sync.changes(withCursor(settled, { legacyHostUuid: hostUuid }));
    expect(legacy.reset, 'a pre-one-list cursor (version, time, first 8 bytes of one HostUUID) resets').toBe(true);
    expect(uuidsOf(legacy.assignments, 'orderAssignmentUuid')).toEqual(allAssignments());

    const stale = await sync.changes(withCursor(settled, { issuedAt: new Date(Date.now() - 91 * 24 * 3600 * 1000) }));
    expect(stale.reset, 'a cursor issued 91 days ago resets').toBe(true);
    expect(stale.assignments).toHaveLength(allAssignments().length);
    const recent = await sync.changes(withCursor(settled, { issuedAt: new Date(Date.now() - 89 * 24 * 3600 * 1000) }));
    expect(recent.reset, 'a cursor issued 89 days ago is still honoured').toBe(false);
  });

  test('SYNC-04 a dispatcher message sent through the host API is the only row in the next delta (AC1)', async ({ request }) => {
    const body = `${MARKER} dispatch delta ${Date.now()}`;
    const { messageUuid, threadUuid } = await dispatch(request, 'chat', body);
    expect(Object.values(seeded.uuids), "the host files the message on one of the driver's assignments").toContain(threadUuid);
    await mirroredMessage(body);

    const delta = await sync.changes(settled);
    expect(delta.reset).toBe(false);
    expect(
      delta.messages.map((m) => ({
        messageUuid: m.messageUuid.toLowerCase(),
        messageBody: m.messageBody,
        isFromDispatch: m.isFromDispatch,
        orderAssignmentUuid: m.orderAssignmentUuid,
      })),
    ).toEqual([{ messageUuid, messageBody: body, isFromDispatch: true, orderAssignmentUuid: threadUuid }]);
    expect({ assignments: delta.assignments.map((a) => a.orderAssignmentUuid), trips: delta.trips, deleted: delta.deleted }, 'nothing else changed').toEqual({
      assignments: [],
      trips: [],
      deleted: [],
    });

    settled = await settle(delta.cursor);
  });

  test('SYNC-05 an assignment the host deletes and one it moves to another driver come back in deleted, and never as current rows too (AC1)', async () => {
    test.skip(true, 'QC-920: a SQL delete or driver change on the host raises no event (no triggers); host reassignment and cancel are covered by DEVT-09.');
    const from = settled;
    hostValue(`UPDATE app.OrderAssignments SET Active = 0, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.gone}`);
    hostValue(
      `UPDATE app.OrderAssignments SET DriverUserID_FK = ${sqlText(seeded.secondDriverId)}, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.move}`,
    );

    await expect
      .poll(
        async () => {
          const delta = await sync.changes(from);
          return delta.deleted
            .filter((d) => d.type === 'assignment')
            .map((d) => d.uuid.toLowerCase())
            .sort();
        },
        { message: 'the mirror removes both assignments and writes tombstones for them', timeout: SNAPSHOT_WINDOW, ...POLL },
      )
      .toEqual([seeded.uuids.gone, seeded.uuids.move].sort());

    const delta = await sync.changes(from);
    expect(delta.reset).toBe(false);
    const current = new Set([
      ...delta.assignments.map((a) => a.orderAssignmentUuid.toLowerCase()),
      ...delta.trips.map((t) => t.tripUuid.toLowerCase()),
      ...delta.messages.map((m) => m.messageUuid.toLowerCase()),
    ]);
    expect(
      delta.deleted.filter((d) => current.has(d.uuid.toLowerCase())),
      'no uuid is both deleted and current',
    ).toEqual([]);
    expect(delta.deleted.every((d) => ['assignment', 'trip', 'ticket', 'message'].includes(d.type))).toBe(true);
    expect(new Set(delta.deleted.map((d) => `${d.type}:${d.uuid}`)).size, 'each tombstone once').toBe(delta.deleted.length);
    expect(
      driversNumber(
        `SELECT COUNT(*) FROM app.SyncTombstones WHERE ${driversColumns().user} = ${sqlText(seeded.userId)} AND EntityType = 'assignment' AND EntityUUID IN ('${seeded.uuids.gone}', '${seeded.uuids.move}')`,
      ),
    ).toBeGreaterThanOrEqual(2);

    const reset = await sync.changes();
    expect(uuidsOf(reset.assignments, 'orderAssignmentUuid'), 'a reset lists only what is still current').toEqual(
      [seeded.uuids.work, seeded.uuids.tomorrow, seeded.uuids.other, seeded.uuids.chat].sort(),
    );
    expect(reset.deleted).toEqual([]);

    settled = await settle(delta.cursor);
  });

  test('SYNC-06 a registered device gets one visible message push for a dispatcher message (QC-918), a Gone token is turned off, and a removed device gets none (AC7)', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const stub = ExpoStubLog.open();
    test.skip(!stub, 'Needs EXPO_STUB_LOG: the log of the local Expo push stub the Drivers API posts to (Push__ExpoUrl).');
    const run = Date.now();
    const token = `ExponentPushToken[${MARKER}-${run}]`;
    const goneToken = `ExponentPushToken[${MARKER}-Gone-${run}]`;
    const deviceId = `${MARKER}-device-${run}`;
    const goneDeviceId = `${MARKER}-gone-${run}`;

    for (const [label, device] of [
      ['a token that is not an Expo token', { token: 'abc', platform: 'ios', deviceId }],
      ['no token', { platform: 'ios', deviceId }],
      ['a platform other than ios or android', { token, platform: 'windows', deviceId }],
      ['no device id', { token, platform: 'android', deviceId: ' ' }],
      ['a 201-character device id', { token, platform: 'android', deviceId: 'd'.repeat(201) }],
    ] as const) {
      expect((await sync.registerDevice(device)).status(), label).toBe(400);
    }
    expect(
      driversNumber(`SELECT COUNT(*) FROM app.DeviceTokens WHERE ${driversColumns().user} = ${sqlText(seeded.userId)}`),
      'no row for a refused registration',
    ).toBe(0);

    const registered = await sync.registerDevice({ token, platform: 'ios', deviceId });
    expect(registered.status(), 'PUT /devices needs no X-Host-Uuid').toBe(200);
    expect((await registered.json()).data).toMatchObject({ platform: 'ios', deviceId });
    expect((await sync.registerDevice({ token: goneToken, platform: 'android', deviceId: goneDeviceId })).status()).toBe(200);
    expect((await sync.registerDevice({ token, platform: 'ios', deviceId })).status(), 'registering the same token again').toBe(200);
    expect(
      driversValue(
        `SELECT STRING_AGG(CONCAT(Platform, ':', Active), ',') WITHIN GROUP (ORDER BY Platform) FROM app.DeviceTokens WHERE ${driversColumns().user} = ${sqlText(seeded.userId)}`,
      ),
      'one active row per token',
    ).toBe('android:1,ios:1');

    const mark = stub!.mark();
    const pushBody = `${MARKER} push ${run}`;
    await dispatch(request, 'chat', pushBody);
    await mirroredMessage(pushBody);
    await expect
      .poll(() => stub!.pushesTo(mark, token).length, { message: 'the Drivers API posts a message push to Expo', timeout: 15_000, ...POLL })
      .toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, PUSH_SETTLE_MS));
    const handedOver = hostValue(
      `SELECT CONVERT(varchar(23), MIN(c.ProcessedAt), 126) FROM app.DriverMirrorChanges c JOIN app.Messages m ON m.MessageID = c.MessageID_FK WHERE m.MessageBody = ${sqlText(pushBody)} AND c.UserID_FK = ${sqlText(seeded.userId)}`,
    );
    const mirroredAt = handedOver ? Date.parse(`${handedOver}Z`) : 0;
    const all = stub!.pushesTo(mark, token);
    const pushes = all.filter((p) => Date.parse(p.at) >= mirroredAt - 500);
    test.info().annotations.push(
      {
        type: 'pushes-before-the-host-sent-the-message-snapshot',
        description: `${all.length - pushes.length} (host change row processed at ${new Date(mirroredAt).toISOString()})`,
      },
      { type: 'push-times', description: pushes.map((p) => `${p.at} (${p.messages.length} token(s))`).join(', ') },
      {
        type: 'host-changes-since-message',
        description:
          hostValue(
            `SELECT STRING_AGG(CONCAT(CONVERT(varchar(12), c.Created, 114), ' oa=', ISNULL(CONVERT(varchar(10), c.OrderAssignmentID_FK), '-'), ' msg=', ISNULL(CONVERT(varchar(10), c.MessageID_FK), '-'), ' done=', CONVERT(varchar(12), c.ProcessedAt, 114)), ' | ') FROM app.DriverMirrorChanges c WHERE c.UserID_FK = ${sqlText(seeded.userId)} AND c.Created >= DATEADD(SECOND, -2, (SELECT MIN(SentAt) FROM app.Messages WHERE MessageBody = ${sqlText(pushBody)}))`,
          ) ?? 'none',
      },
      { type: 'chat-assignment-id', description: `${seeded.ids.chat}` },
    );
    expect(pushes, 'exactly one push request for the device').toHaveLength(1);
    const message = pushes[0].messages.find((m) => m.to === token)!;
    expect(message).toMatchObject({
      to: token,
      title: expect.stringMatching(/^Message from /),
      body: pushBody,
      sound: 'default',
      data: { type: 'message', hostUuid: hostUuid.toLowerCase() },
      _contentAvailable: true,
      priority: 'high',
    });
    expect(String((message.data as Record<string, unknown>).messageUuid), 'the message push names the message').toMatch(/^[0-9a-f-]{36}$/);

    await expect
      .poll(() => driversValue(`SELECT CAST(Active AS int) FROM app.DeviceTokens WHERE Token = ${sqlText(goneToken)}`), {
        message: 'Expo said DeviceNotRegistered, so the token is turned off',
        timeout: 15_000,
        ...POLL,
      })
      .toBe('0');
    expect(driversValue(`SELECT CAST(Active AS int) FROM app.DeviceTokens WHERE Token = ${sqlText(token)}`)).toBe('1');

    const removed = await sync.removeDevice(deviceId);
    expect(removed.status()).toBe(200);
    expect(driversValue(`SELECT CAST(Active AS int) FROM app.DeviceTokens WHERE Token = ${sqlText(token)}`)).toBe('0');
    expect((await sync.removeDevice(deviceId)).status(), 'removing it again').toBe(404);
    expect((await sync.removeDevice(`${MARKER}-unknown-${run}`)).status(), 'an unknown device').toBe(404);

    const afterRemove = stub!.mark();
    const quietBody = `${MARKER} after remove ${run}`;
    await dispatch(request, 'chat', quietBody);
    await mirroredMessage(quietBody);
    await new Promise((resolve) => setTimeout(resolve, PUSH_SETTLE_MS));
    expect(stub!.pushesTo(afterRemove, token), 'no push after DELETE /devices').toEqual([]);
    expect(stub!.pushesTo(afterRemove, goneToken), 'no push to the turned-off token').toEqual([]);

    settled = await settle(settled);
  });

  test('SYNC-08 one send-message key sent through POST /sync and then driver-message/send makes one command, one host message and one receipt; the key is 409 for another type (AC3)', async () => {
    const key = randomUUID();
    const body = `${MARKER} idempotent ${Date.now()}`;
    const first = await sync.apply([{ key, type: 'send-message', targetUuid: seeded.uuids.work, messageBody: body }]);
    expect(first.results[0]).toMatchObject({ key, status: 'sent', error: null });
    const messageUuid = first.results[0].targetUuid!.toLowerCase();

    const replay = await sync.sendMessage(seeded.uuids.work, body, key);
    expect(replay.status()).toBe(202);
    expect(isReplayed(replay), 'Idempotent-Replayed: true').toBe(true);
    expect(String((await replay.json()).data.messageUuid).toLowerCase(), 'the replay answers with the current row').toBe(messageUuid);
    const again = await sync.apply([{ key, type: 'send-message', targetUuid: seeded.uuids.work, messageBody: body }]);
    expect(again.results[0]).toMatchObject({ key, status: 'duplicate' });
    expect(again.results[0].targetUuid?.toLowerCase()).toBe(messageUuid);

    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE CommandUUID = '${key}'`), 'one DRIVERS command').toBe(1);
    await expect
      .poll(() => hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageBody = ${sqlText(body)}`), {
        message: 'QC-920: DriverMessageSent stores one host message',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageUUID = '${messageUuid}'`)).toBe(1);

    const otherType = await sync.apply([{ key, type: 'accept-assignment', targetUuid: seeded.uuids.other }]);
    expect(otherType.results[0]).toMatchObject({ key, status: 'conflict' });
    expect(otherType.results[0].error).toBeTruthy();
    const otherRoute = await sync.accept(seeded.uuids.other, key);
    expect(otherRoute.status(), 'the same key on accept-assignment').toBe(409);
    expect(isReplayed(otherRoute)).toBe(false);

    for (const bad of ['not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
      const response = await sync.sendMessage(seeded.uuids.work, `${body} bad key`, bad);
      expect(response.status(), `Idempotency-Key: ${bad}`).toBe(400);
      expect((await response.json()).validationErrors).toHaveProperty('Idempotency-Key');
    }
    expect(hostStatus(seeded.ids.other), 'the conflicting key changed nothing').toBe(1);
    expect(commands(`AND TargetUUID = '${seeded.uuids.other}'`)).toBe(0);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageBody = ${sqlText(`${body} bad key`)}`)).toBe(0);
  });

  test('SYNC-09 a key that accepted one assignment is 409 / conflict for another assignment, and replays only for the first (AC3)', async () => {
    const key = randomUUID();
    const accepted = await sync.accept(seeded.uuids.tomorrow, key);
    expect(accepted.status()).toBe(202);
    expect(isReplayed(accepted)).toBe(false);

    const elsewhere = await sync.accept(seeded.uuids.other, key);
    expect(elsewhere.status(), 'the same key and type on another assignment').toBe(409);
    expect(isReplayed(elsewhere)).toBe(false);
    const batched = await sync.apply([{ key, type: 'accept-assignment', targetUuid: seeded.uuids.other }]);
    expect(batched.results[0]).toMatchObject({ key, status: 'conflict' });

    const replay = await sync.accept(seeded.uuids.tomorrow, key);
    expect(replay.status()).toBe(202);
    expect(isReplayed(replay), 'Idempotent-Replayed: true').toBe(true);
    expect((await replay.json()).data).toMatchObject({ orderAssignmentUuid: seeded.uuids.tomorrow, status: 'accepted' });
    const batchedReplay = await sync.apply([{ key, type: 'accept-assignment', targetUuid: seeded.uuids.tomorrow }]);
    expect(batchedReplay.results[0]).toMatchObject({ key, status: 'duplicate', targetUuid: seeded.uuids.tomorrow });

    expect(
      driversValue(`SELECT CONCAT(COUNT(*), ':', MIN(LOWER(CONVERT(nvarchar(36), TargetUUID)))) FROM app.DriverCommands WHERE CommandUUID = '${key}'`),
      'one command, for the first assignment',
    ).toBe(`1:${seeded.uuids.tomorrow}`);
    await expect
      .poll(() => hostStatus(seeded.ids.tomorrow), { message: 'the host accepts the first assignment once', timeout: SNAPSHOT_WINDOW, ...POLL })
      .toBe(2);
    expect(hostStatus(seeded.ids.other), 'the other assignment is untouched').toBe(1);
    expect((await sync.changes()).assignments.find((a) => a.orderAssignmentUuid === seeded.uuids.other)).toMatchObject({
      status: 'pending',
      pending: false,
    });
  });

  test('SYNC-10 the drivers.mobile access token lives 30 minutes and the Drivers API accepts it (AC4)', async () => {
    expect(issued.expires_in).toBe(ACCESS_TOKEN_SECONDS);
    const { claims } = decodeJwt(issued.access_token!);
    expect(claims.client_id).toBe(env.mobileClientId);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(ACCESS_TOKEN_SECONDS);
    expect((await sync.sync(settled)).status()).toBe(200);
  });

  test('SYNC-11 a batched begin-haul and a keyed end-haul land on the host once, and the ticket upload answers 409 until QC-873; the delta brings the trip with its assignment', async () => {
    if (hostStatus(seeded.ids.work) === 1) {
      expect((await sync.accept(seeded.uuids.work, randomUUID())).status(), 'accept the work job').toBe(202);
    }
    await expect
      .poll(() => hostStatus(seeded.ids.work), { message: 'JobAccepted makes the host accept the work job', timeout: SNAPSHOT_WINDOW, ...POLL })
      .toBe(2);
    const beforeHaul = await settle(settled);

    const beginKey = randomUUID();
    const begin = await sync.apply([{ key: beginKey, type: 'begin-haul', targetUuid: seeded.uuids.work, isOfflineSync: false }]);
    expect(begin.results[0]).toMatchObject({ key: beginKey, status: 'sent' });
    tripUuid = begin.results[0].targetUuid!.toLowerCase();
    expect(tripUuid).not.toBe(seeded.uuids.work);
    await expect
      .poll(() => hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(Status)) FROM app.Trips WHERE TripUUID = '${tripUuid}'`), {
        message: 'TripStarted makes the host trip Active with the same TripUUID',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe('1:20');

    const endKey = randomUUID();
    const end = await sync.endHaul(tripUuid, endKey);
    expect(end.status()).toBe(202);
    expect(isReplayed(end)).toBe(false);
    const endAgain = await sync.endHaul(tripUuid, endKey);
    expect(endAgain.status(), 'end-haul repeated with its key').toBe(202);
    expect(isReplayed(endAgain)).toBe(true);
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE CommandUUID = '${endKey}'`)).toBe(1);
    await expect
      .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`), {
        message: 'TripCompleted makes the host trip Complete',
        timeout: SNAPSHOT_WINDOW,
        ...POLL,
      })
      .toBe(30);

    const file: TicketFile = { name: 'e2e-qc829-ticket.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(TICKET_JPEG) };
    const upload = await sync.uploadTicket(tripUuid, file, { key: randomUUID(), sha256: sha256(file.buffer) });
    expect(upload.status(), `QC-920: ticket upload waits on QC-873: ${await upload.text()}`).toBe(409);

    const delta = await sync.changes(beforeHaul);
    expect(
      delta.trips.map((t) => t.tripUuid.toLowerCase()),
      'the new trip comes back in the delta',
    ).toContain(tripUuid);
    expect(
      delta.assignments.map((a) => a.orderAssignmentUuid),
      'the changed trip brings its assignment',
    ).toContain(seeded.uuids.work);
    settled = delta.cursor;
  });

  test('SYNC-12 the same photo again is a duplicate with no second command, with or without X-Content-SHA256, and a wrong hash is 400 (AC6)', async () => {
    test.skip(true, 'QC-920: ticket upload answers 409 until QC-873 (SYNC-11, DEVT-11), so there is no photo to repeat.');
    test.skip(!uploaded, 'SYNC-11 did not upload a photo (skipped or failed).');
    const file: TicketFile = { name: 'e2e-qc829-ticket-again.jpg', mimeType: 'image/jpeg', buffer: uploaded! };
    const uploads = () => commands(`AND CommandType = 'upload-ticket' AND TargetUUID = '${tripUuid}'`);
    expect(uploads()).toBe(1);

    for (const [label, options] of [
      ['a new key with the same X-Content-SHA256', { key: randomUUID(), sha256: sha256(uploaded!) }],
      ['the same photo with no headers (the server hashes it)', {}],
      ['the first Idempotency-Key again', { key: uploadKey }],
    ] as const) {
      const again = await sync.uploadTicket(tripUuid, file, options);
      expect(again.status(), label).toBe(202);
      expect(isReplayed(again), `${label}: Idempotent-Replayed`).toBe(true);
      expect((await again.json()).message, label).toContain('already uploaded');
    }

    const other = Buffer.concat([uploaded!, Buffer.from(MARKER)]);
    const wrong = await sync.uploadTicket(tripUuid, file, { key: randomUUID(), sha256: sha256(other) });
    expect(wrong.status(), 'a hash of other bytes').toBe(400);
    expect((await wrong.json()).validationErrors).toHaveProperty('X-Content-SHA256');
    expect((await sync.uploadTicket(tripUuid, file, { sha256: 'abc123' })).status(), 'a hash that is not 64 hex characters').toBe(400);
    expect((await sync.uploadTicket(tripUuid, file, { key: 'not-a-uuid' })).status(), 'a non-UUID Idempotency-Key').toBe(400);
    expect(uploads(), 'still one upload command').toBe(1);
    expect(
      hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID = '${uploadKey}'`),
      'the host handled the upload once',
    ).toBeLessThanOrEqual(1);
  });

  test('SYNC-13 every driver write is final in DRIVERS (no pending command on any row), and the one begin-haul made one host trip', async () => {
    const pending = (table: string) =>
      driversNumber(
        `SELECT COUNT(*) FROM app.${table} WHERE ${['OrderAssignments', 'Messages'].includes(table) ? driversColumns().driverUser : driversColumns().user} = ${sqlText(seeded.userId)} AND PendingCommandUUID IS NOT NULL`,
      );
    expect(
      { assignments: pending('OrderAssignments'), trips: pending('Trips'), messages: pending('Messages'), tickets: pending('Tickets') },
      'QC-920: no host result comes back, so no row waits on one',
    ).toEqual({ assignments: 0, trips: 0, messages: 0, tickets: 0 });
    expect(commands(), 'the writes this run made keep their idempotency keys').toBeGreaterThanOrEqual(5);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${seeded.ids.work}`), 'one host trip').toBe(1);
  });

  test('SYNC-14 a cursor that is not base64url at all (a stray last character, symbols, spaces) is 400 since, not a server error (AC1)', async () => {
    for (const bad of [`${settled}x`, 'A', 'AAAAA', '!!!!', 'a b c d']) {
      const get = await sync.sync(bad);
      expect(get.status(), `GET /sync?since=${bad}`).toBe(400);
      expect((await get.json()).validationErrors).toHaveProperty('since');
      expect((await sync.push([], bad)).status(), `POST /sync with since ${bad}`).toBe(400);
    }
  });

  test('SYNC-07 POST /sync answers each operation on its own: invalid and unknown ones do not stop the valid ones, which land on the host (AC2)', async () => {
    const keys = { accept: randomUUID(), seen: randomUUID(), send: randomUUID(), reject: randomUUID(), unknown: randomUUID(), missing: randomUUID() };
    const body = `${MARKER} batched reply ${Date.now()}`;
    const { results, changes } = await sync.apply(
      [
        { key: keys.accept, type: 'accept-assignment', targetUuid: seeded.uuids.other, isOfflineSync: true },
        { key: keys.seen, type: 'mark-thread-seen', targetUuid: seeded.uuids.work },
        { key: keys.send, type: 'send-message', targetUuid: seeded.uuids.work, messageBody: body },
        { key: keys.reject, type: 'reject-assignment', targetUuid: seeded.uuids.other, notes: '   ' },
        { key: keys.unknown, type: 'teleport', targetUuid: seeded.uuids.work },
        { key: null, type: 'accept-assignment', targetUuid: seeded.uuids.work },
        { key: keys.missing, type: 'accept-assignment', targetUuid: randomUUID() },
      ],
      settled,
    );

    expect(results.map((r) => [r.key, r.type, r.status])).toEqual([
      [keys.accept, 'accept-assignment', 'sent'],
      [keys.seen, 'mark-thread-seen', 'conflict'],
      [keys.send, 'send-message', 'sent'],
      [keys.reject, 'reject-assignment', 'invalid'],
      [keys.unknown, 'teleport', 'invalid'],
      [null, 'accept-assignment', 'invalid'],
      [keys.missing, 'accept-assignment', 'not-found'],
    ]);
    expect(results.filter((r) => r.status === 'sent').every((r) => r.error === null)).toBe(true);
    expect(results[1].error, 'the conflict says why').toBeTruthy();
    expect(
      results.filter((r) => r.status !== 'sent').every((r) => !!r.error),
      'every refusal says why',
    ).toBe(true);
    const messageUuid = results[2].targetUuid!.toLowerCase();
    expect(messageUuid, 'send-message answers with the new message uuid').not.toBe(keys.send);

    expect(changes.reset).toBe(false);
    expect(
      changes.assignments.find((a) => a.orderAssignmentUuid === seeded.uuids.other),
      'the changes since the cursor carry the accept, final in DRIVERS',
    ).toMatchObject({ status: 'accepted', pending: false });
    expect(changes.messages.map((m) => m.messageUuid.toLowerCase())).toContain(messageUuid);

    await expect.poll(() => hostStatus(seeded.ids.other), { message: 'the host accepts the job', timeout: SNAPSHOT_WINDOW, ...POLL }).toBe(2);
    try {
      await expect
        .poll(
          () =>
            hostValue(
              `SELECT CONCAT(COUNT(*), ':', MIN(Direction)) FROM app.Messages WHERE MessageUUID = '${messageUuid}' AND OrderAssignmentID_FK = ${seeded.ids.work}`,
            ),
          { message: 'the host stores the driver message once', timeout: SNAPSHOT_WINDOW, ...POLL },
        )
        .toBe('1:10');
    } finally {
      test.info().annotations.push(
        {
          type: 'drivers-commands',
          description:
            driversValue(
              `SELECT STRING_AGG(CONCAT(CommandType, ' ', Status, ' ', ISNULL(Error, '')), ' | ') FROM app.DriverCommands WHERE CommandUUID IN ('${keys.accept}', '${keys.seen}', '${keys.send}')`,
            ) ?? 'none',
        },
        {
          type: 'host-message-by-body',
          description:
            hostValue(
              `SELECT STRING_AGG(CONCAT(LOWER(CONVERT(nvarchar(36), MessageUUID)), ' ', Direction, ' ', OrderAssignmentID_FK), ' | ') FROM app.Messages WHERE MessageBody = ${sqlText(body)}`,
            ) ?? 'none',
        },
        { type: 'expected-message', description: `${messageUuid} on ${seeded.ids.work}; send key ${keys.send}` },
      );
    }
    expect(
      driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE CommandUUID IN ('${keys.reject}', '${keys.unknown}', '${keys.missing}')`),
      'nothing was sent for the refused operations',
    ).toBe(0);
    expect(
      hostNumber(
        `SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${seeded.ids.other} AND OrderAssignmentHistoryData LIKE N'%reject%'`,
      ),
      'the invalid reject changed nothing',
    ).toBe(0);

    settled = await settle(changes.cursor);
  });

  test('SYNC-15 one GET /sync covers both linked Hosts: every assignment and message carries its HostUUID, and X-Host-Uuid changes nothing (D66)', async () => {
    test.skip(!driversColumns().migrated, 'DRIVERS_SQL_DATABASE has no QC-902 one-list migrations (027-030).');
    const all = await sync.changes();
    expect(all.reset).toBe(true);
    expect(uuidsOf(all.assignments, 'orderAssignmentUuid')).toEqual(allAssignments());
    const hostOf = new Map(all.assignments.map((a) => [a.orderAssignmentUuid.toLowerCase(), String(a.HostUUID).toLowerCase()]));
    for (const role of ROLES) expect(hostOf.get(seeded.uuids[role]), `${role} is a first-host row`).toBe(hostUuid);
    for (const uuid of secondRows()) expect(hostOf.get(uuid), 'a second-host row').toBe(seeded.secondHostUuid);
    expect(
      all.messages.every((m) => String(m.HostUUID).toLowerCase() === hostOf.get(m.orderAssignmentUuid.toLowerCase())),
      'each message carries the HostUUID of its assignment',
    ).toBe(true);
    expect(
      all.trips.every((t) => String(t.HostUUID).toLowerCase() === hostOf.get(t.orderAssignmentUuid.toLowerCase())),
      'each trip too',
    ).toBe(true);

    for (const header of [hostUuid, seeded.secondHostUuid, randomUUID()]) {
      const narrowed = await sync.changes(null, header);
      expect(uuidsOf(narrowed.assignments, 'orderAssignmentUuid'), `X-Host-Uuid ${header} is ignored`).toEqual(allAssignments());
    }
  });

  test('SYNC-16 a cursor issued before the set of linked dispatch-enabled Hosts changed resets, and resets again when the set changes back (D66)', async () => {
    test.skip(!driversColumns().migrated, 'DRIVERS_SQL_DATABASE has no QC-902 one-list migrations (027-030).');
    const quiet = await settle(settled);
    expect((await sync.changes(quiet)).reset, 'the same set keeps the cursor').toBe(false);

    const dispatch = (on: 0 | 1) => queryDriversDb(`UPDATE app.Hosts SET DispatchEnabled = ${on} WHERE HostUUID = '${seeded.secondHostUuid}'`);
    let whileOff = '';
    try {
      dispatch(0);
      const off = await sync.changes(quiet);
      expect(off.reset, 'turning the second host dispatch off changes the set').toBe(true);
      expect(uuidsOf(off.assignments, 'orderAssignmentUuid'), "the second host's rows leave the list").toEqual(ROLES.map((role) => seeded.uuids[role]).sort());
      whileOff = off.cursor;
      expect((await sync.changes(whileOff)).reset, 'a cursor from the new set is honoured').toBe(false);
    } finally {
      dispatch(1);
    }
    expect(driversValue(`SELECT CAST(DispatchEnabled AS int) FROM app.Hosts WHERE HostUUID = '${seeded.secondHostUuid}'`)).toBe('1');
    const back = await sync.changes(whileOff);
    expect(back.reset, 'dispatch back on changes the set again').toBe(true);
    expect(uuidsOf(back.assignments, 'orderAssignmentUuid')).toEqual(allAssignments());

    const link = `UPDATE app.DriverHostLinks SET Active = {0} WHERE ${driversColumns().user} = ${sqlText(seeded.userId)} AND HostUUID = '${seeded.secondHostUuid}'`;
    try {
      queryDriversDb(link.replace('{0}', '0'));
      const unlinked = await sync.changes(back.cursor);
      expect(unlinked.reset, 'an inactive link changes the set too').toBe(true);
      expect(uuidsOf(unlinked.assignments, 'orderAssignmentUuid')).toEqual(ROLES.map((role) => seeded.uuids[role]).sort());
    } finally {
      queryDriversDb(link.replace('{0}', '1'));
    }
    expect(
      driversValue(
        `SELECT CAST(Active AS int) FROM app.DriverHostLinks WHERE ${driversColumns().user} = ${sqlText(seeded.userId)} AND HostUUID = '${seeded.secondHostUuid}'`,
      ),
    ).toBe('1');
    settled = await settle(back.cursor);
  });

  test('SYNC-17 Begin Haul while a load is open on another Host is 409 naming that Host, and conflict through POST /sync; nothing reaches the first host (D67)', async () => {
    test.skip(!driversColumns().migrated, 'DRIVERS_SQL_DATABASE has no QC-902 one-list migrations (027-030).');
    const trips = () => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${seeded.ids.work}`);
    const hostTripsBefore = trips();
    const open = await sync.beginHaul(seeded.second.accepted, randomUUID());
    expect(open.status(), await open.text()).toBe(202);
    const openTrip = String((await open.json()).data.tripUuid).toLowerCase();
    const expected = 'Finish your open load for E2E QC-829 Second host (as hauled) before starting another.';
    try {
      const direct = await sync.beginHaul(seeded.uuids.work, randomUUID());
      expect(direct.status(), await direct.text()).toBe(409);
      expect((await direct.json()).errors).toEqual([expected]);

      const key = randomUUID();
      const batched = await sync.apply([{ key, type: 'begin-haul', targetUuid: seeded.uuids.work, isOfflineSync: false }]);
      expect(batched.results[0]).toMatchObject({ key, status: 'conflict', error: expected });
      expect(commands(`AND CommandUUID = '${key}'`), 'the refused begin-haul keeps no command').toBe(0);
    } finally {
      expect((await sync.endHaul(openTrip, randomUUID())).status(), 'end the second-host load').toBe(202);
    }
    expect(trips(), 'no new host trip on the first host').toBe(hostTripsBefore);
    expect(driversValue(`SELECT CONCAT(LOWER(CONVERT(nvarchar(36), HostUUID)), '|', Status) FROM app.Trips WHERE TripUUID = '${openTrip}'`)).toBe(
      `${seeded.secondHostUuid}|30`,
    );
  });
});
