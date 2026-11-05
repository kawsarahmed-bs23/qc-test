import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../fixtures/test';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '../fixtures/localDb';
import { HostApi } from '../pages/DriversMirrorApi';
import { isReplayed, withCursor, type TicketFile } from '../pages/DriverSyncApi';
import { HostDriverSyncApi, type HostSyncPayload } from '../pages/HostDriverSyncApi';
import { env } from '../config/environment';

const DRIVER_EMAIL = 'e2e.qc829h.driver@quarryconnect.test';
const SECOND_DRIVER_EMAIL = 'e2e.qc829h.driver2@quarryconnect.test';
const DISPATCHER_EMAIL = 'e2e.qc829h.dispatcher@quarryconnect.test';
const MARKER = 'e2e-qc829h';
const TICKET_JPEG = path.resolve(__dirname, '..', 'fixtures', 'qc803', 'logo-solid.jpg');
const DAY_MS = 24 * 3600 * 1000;

type Role = 'work' | 'other' | 'edit' | 'gone' | 'move' | 'chat';
const ROLES: Role[] = ['work', 'other', 'edit', 'gone', 'move', 'chat'];

interface Seeded {
  userId: string;
  secondDriverId: string;
  ids: Record<Role, number>;
  uuids: Record<Role, string>;
  orders: Record<Role, number>;
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

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function idsOf<T>(rows: T[], field: keyof T): number[] {
  return rows.map((row) => Number(row[field])).sort((a, b) => a - b);
}

function withoutCursor(payload: HostSyncPayload): Omit<HostSyncPayload, 'cursor'> {
  const { cursor: _cursor, ...rest } = payload;
  return rest;
}

function cursorVersion(cursor: string): bigint {
  return Buffer.from(cursor, 'base64url').readBigInt64BE(0);
}

function hostHasTicketStatusColumn(): boolean {
  return hostNumber(`SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(N'app.Tickets') AND name = N'TicketStatusID_FK'`) === 1;
}

function removeAll(): void {
  runSeedScript('host-qc829h.remove.sql');
}

test.describe('Host API local-first driver sync: delta reads, batched writes and idempotency keys (QC-829)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseIdentityDb(), 'Needs the host and Identity local databases (local only; Identity is only read for the password hash).');
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway host users copy that password.');
  test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

  let seeded: Seeded;
  let context: APIRequestContext;
  let driver: HostDriverSyncApi;
  let settled = '';
  let tripId = 0;
  let uploaded: Buffer | null = null;

  const receipts = (where: string) => hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE UserID_FK = ${sqlText(seeded.userId)} AND ${where}`);
  const assignmentStatus = (role: Role) => hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${seeded.ids[role]}`);
  const messagesByBody = (body: string) => hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageBody = ${sqlText(body)}`);

  const dispatcher = async (): Promise<HostApi> => {
    const api = new HostApi(context);
    expect(await api.signIn(DISPATCHER_EMAIL, env.admin!.password), 'the throwaway dispatcher signs in to the host API').toBe(200);
    return api;
  };

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(90_000);
    removeAll();
    runSeedScript('host-qc829h.apply.sql', { SourceEmail: env.admin!.email, IdentityDb: env.identitySql!.database });

    const userId = hostValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER_EMAIL)})`);
    const secondDriverId = hostValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(SECOND_DRIVER_EMAIL)})`);
    expect(userId, 'the throwaway host driver exists').not.toBeNull();
    expect(secondDriverId, 'the second throwaway host driver exists').not.toBeNull();

    const ids = {} as Record<Role, number>;
    const uuids = {} as Record<Role, string>;
    const orders = {} as Record<Role, number>;
    for (const role of ROLES) {
      const row = hostValue(
        `SELECT CONCAT(OrderAssignmentID, '|', LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)), '|', OrderID_FK) FROM app.OrderAssignments WHERE DriverUserID_FK = ${sqlText(userId!)} AND Notes = N'${MARKER} ${role}'`,
      );
      expect(row, `seeded ${role} assignment`).toBeTruthy();
      const [id, uuid, orderId] = row!.split('|');
      ids[role] = Number(id);
      uuids[role] = uuid;
      orders[role] = Number(orderId);
    }
    seeded = { userId: userId!, secondDriverId: secondDriverId!, ids, uuids, orders };

    context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    driver = await HostDriverSyncApi.signIn(context, DRIVER_EMAIL, env.admin!.password);
  });

  test.afterAll(async () => {
    await context?.dispose();
    removeAll();
  });

  test('HSYNC-01 the first host sync has no cursor, so it is a reset with every seeded assignment and message by int id, and no tombstones', async () => {
    const first = await driver.changes();
    expect(first.reset).toBe(true);
    expect(first.cursor).toBeTruthy();
    expect(idsOf(first.assignments, 'orderAssignmentId')).toEqual(ROLES.map((role) => seeded.ids[role]).sort((a, b) => a - b));
    const seededMessages = (hostValue(`SELECT STRING_AGG(m.MessageID, ',') FROM app.Messages m JOIN app.OrderAssignments oa ON oa.OrderAssignmentID = m.OrderAssignmentID_FK WHERE oa.DriverUserID_FK = ${sqlText(seeded.userId)}`) ?? '')
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    expect(seededMessages, 'two seeded dispatch messages').toHaveLength(2);
    expect(idsOf(first.messages, 'messageId'), 'the dispatch message to the driver and the one on the move job that names no driver').toEqual(seededMessages);
    expect(first.trips).toEqual([]);
    expect(first.deleted, 'a reset carries no tombstones').toEqual([]);
    expect(first.assignments.find((a) => a.orderAssignmentId === seeded.ids.work), 'assignment rows have the my-assignments shape').toMatchObject({
      status: 'pending',
      completedTripCount: 0,
      notes: `${MARKER} work`,
    });
    expect(first.messages.every((m) => m.isFromDispatch)).toBe(true);
    settled = first.cursor;
  });

  test('HSYNC-02 the same cursor twice with nothing changed in between returns the same empty delta, and the cursor does not move back', async () => {
    const once = await driver.changes(settled);
    const twice = await driver.changes(settled);
    expect(withoutCursor(once)).toEqual({ reset: false, assignments: [], trips: [], messages: [], deleted: [] });
    expect(withoutCursor(twice)).toEqual(withoutCursor(once));
    expect(cursorVersion(once.cursor)).toBeGreaterThanOrEqual(cursorVersion(settled));
    settled = twice.cursor;
  });

  test('HSYNC-03 a malformed cursor is 400 on GET and POST, more than 50 operations is 400, and a cursor over 90 days old resets', async () => {
    for (const bad of ['not-a-cursor', 'AAAA', `${settled}AAAA`, `${settled}x`, '!!!!', 'a b c d']) {
      expect((await driver.sync(bad)).status(), `GET api/driver-sync?since=${bad}`).toBe(400);
    }
    expect((await driver.push([], 'not-a-cursor')).status(), 'POST api/driver-sync with a malformed since').toBe(400);

    const before = receipts('1 = 1');
    const tooMany = Array.from({ length: 51 }, () => ({ key: randomUUID(), type: 'mark-thread-seen', targetId: seeded.ids.work }));
    expect((await driver.push(tooMany)).status(), '51 operations').toBe(400);
    expect(receipts('1 = 1'), 'nothing was applied').toBe(before);

    const stale = await driver.changes(withCursor(settled, { issuedAt: new Date(Date.now() - 91 * DAY_MS) }));
    expect(stale.reset, 'a cursor issued 91 days ago resets').toBe(true);
    expect(stale.assignments).toHaveLength(ROLES.length);
    const recent = await driver.changes(withCursor(settled, { issuedAt: new Date(Date.now() - 89 * DAY_MS) }));
    expect(recent.reset, 'a cursor issued 89 days ago is still honoured').toBe(false);
  });

  test('HSYNC-04 a change to an order brings back only its assignment in the next delta', async () => {
    const from = settled;
    hostValue(`UPDATE app.Orders SET Updated = GETUTCDATE() WHERE OrderID = ${seeded.orders.edit}`);
    const delta = await driver.changes(from);
    expect(delta.reset).toBe(false);
    expect(idsOf(delta.assignments, 'orderAssignmentId')).toEqual([seeded.ids.edit]);
    expect({ trips: delta.trips, messages: delta.messages, deleted: delta.deleted }).toEqual({ trips: [], messages: [], deleted: [] });
    settled = delta.cursor;
  });

  test('HSYNC-05 a dispatcher message sent through the host API arrives in the next delta', async () => {
    const from = settled;
    const body = `${MARKER} dispatch delta ${Date.now()}`;
    const sent = await (await dispatcher()).sendDispatchMessage(seeded.userId, seeded.ids.chat, body);
    expect(sent.status(), `the host stores the dispatch message: ${sent.status() === 200 ? '' : await sent.text()}`).toBe(200);
    const stored = hostValue(`SELECT CONCAT(COUNT(*), '|', MIN(MessageID), '|', MIN(OrderAssignmentID_FK)) FROM app.Messages WHERE MessageBody = ${sqlText(body)}`)!;
    const [count, messageId, threadId] = stored.split('|').map(Number);
    expect(count, `the host stored the dispatch message once (${stored})`).toBe(1);
    expect(threadId).toBe(seeded.ids.chat);

    const delta = await driver.changes(from);
    expect(delta.reset).toBe(false);
    expect(delta.messages.map((m) => ({ messageId: m.messageId, messageBody: m.messageBody, isFromDispatch: m.isFromDispatch, orderAssignmentId: m.orderAssignmentId })))
      .toEqual([{ messageId, messageBody: body, isFromDispatch: true, orderAssignmentId: seeded.ids.chat }]);
    expect(delta.assignments.every((a) => a.orderAssignmentId === seeded.ids.chat), 'no other assignment changed').toBe(true);
    expect({ trips: delta.trips, deleted: delta.deleted }).toEqual({ trips: [], deleted: [] });
    settled = delta.cursor;
  });

  test('HSYNC-06 an order voided through DELETE api/order shows its assignment in deleted with id and uuid, never as current, and a reset leaves it out', async () => {
    const from = settled;
    const voided = await (await dispatcher()).voidOrder(seeded.orders.gone);
    expect(voided.status(), `DELETE api/order/${seeded.orders.gone}: ${voided.status() === 200 ? '' : await voided.text()}`).toBe(200);
    expect(hostValue(`SELECT CAST(Active AS int) FROM app.OrderAssignments WHERE OrderAssignmentID = ${seeded.ids.gone}`), 'the void soft-deletes the assignment').toBe('0');

    const delta = await driver.changes(from);
    expect(delta.reset).toBe(false);
    expect(delta.deleted).toEqual([{ type: 'assignment', id: seeded.ids.gone, uuid: seeded.uuids.gone }]);
    expect(delta.assignments.map((a) => a.orderAssignmentId), 'the voided assignment is not current too').not.toContain(seeded.ids.gone);

    const reset = await driver.changes();
    expect(idsOf(reset.assignments, 'orderAssignmentId')).not.toContain(seeded.ids.gone);
    settled = delta.cursor;
  });

  test('HSYNC-07 an assignment moved to a second driver shows in the first driver\'s deleted from its tombstone, does not come back as current, and is current for the second driver', async () => {
    const from = settled;
    hostValue(`UPDATE app.OrderAssignments SET DriverUserID_FK = ${sqlText(seeded.secondDriverId)}, Updated = GETUTCDATE() WHERE OrderAssignmentID = ${seeded.ids.move}`);
    expect(
      hostNumber(`SELECT COUNT(*) FROM app.DriverSyncTombstones WHERE DriverUserID_FK = ${sqlText(seeded.userId)} AND EntityType = N'assignment' AND EntityID = ${seeded.ids.move}`),
      'TR_OrderAssignments_DriverSync writes a tombstone for the first driver',
    ).toBe(1);

    const delta = await driver.changes(from);
    expect(delta.reset).toBe(false);
    expect(delta.deleted).toEqual([{ type: 'assignment', id: seeded.ids.move, uuid: seeded.uuids.move }]);
    expect(delta.assignments.map((a) => a.orderAssignmentId)).not.toContain(seeded.ids.move);
    expect(await driver.changes(delta.cursor), 'the tombstone is not repeated').toMatchObject({ reset: false, assignments: [], deleted: [] });

    const reset = await driver.changes();
    expect(idsOf(reset.assignments, 'orderAssignmentId'), 'a reset lists only what is still the first driver\'s').toEqual(
      [seeded.ids.work, seeded.ids.other, seeded.ids.edit, seeded.ids.chat].sort((a, b) => a - b),
    );
    expect(reset.messages.map((m) => m.orderAssignmentId), 'the moved job\'s thread goes with it').not.toContain(seeded.ids.move);

    const second = await (await HostDriverSyncApi.signIn(context, SECOND_DRIVER_EMAIL, env.admin!.password)).changes();
    expect(idsOf(second.assignments, 'orderAssignmentId'), 'the second driver now has the job').toEqual([seeded.ids.move]);
    expect(second.messages.map((m) => m.orderAssignmentId), 'with its dispatch message that names no driver').toEqual([seeded.ids.move]);
    settled = delta.cursor;
  });

  test('HSYNC-08 POST api/driver-sync answers each operation on its own, the valid ones land once, and the same batch again is all duplicate', async () => {
    const keys = { accept: randomUUID(), seen: randomUUID(), send: randomUUID(), reject: randomUUID(), unknown: randomUUID(), missing: randomUUID() };
    const body = `${MARKER} batched reply ${Date.now()}`;
    const batch = [
      { key: keys.accept, type: 'accept-assignment', targetId: seeded.ids.other, isOfflineSync: true },
      { key: keys.seen, type: 'mark-thread-seen', targetId: seeded.ids.work },
      { key: keys.send, type: 'send-message', targetId: seeded.ids.work, messageBody: body },
      { key: keys.reject, type: 'reject-assignment', targetId: seeded.ids.other, notes: '   ' },
      { key: keys.unknown, type: 'teleport', targetId: seeded.ids.work },
      { key: null, type: 'accept-assignment', targetId: seeded.ids.work },
      { key: keys.missing, type: 'accept-assignment', targetId: seeded.ids.gone },
    ];
    const { results, changes } = await driver.apply(batch, settled);

    expect(results.map((r) => [r.key, r.type, r.status])).toEqual([
      [keys.accept, 'accept-assignment', 'sent'],
      [keys.seen, 'mark-thread-seen', 'sent'],
      [keys.send, 'send-message', 'sent'],
      [keys.reject, 'reject-assignment', 'invalid'],
      [keys.unknown, 'teleport', 'invalid'],
      [null, 'accept-assignment', 'invalid'],
      [keys.missing, 'accept-assignment', 'not-found'],
    ]);
    expect(results.filter((r) => r.status === 'sent').every((r) => r.error === null)).toBe(true);
    expect(results.filter((r) => r.status !== 'sent').every((r) => !!r.error), 'every refusal says why').toBe(true);
    const messageId = results[2].targetId!;
    expect(hostValue(`SELECT CONCAT(OrderAssignmentID_FK, ':', Direction, ':', LOWER(CONVERT(nvarchar(36), MessageUUID))) FROM app.Messages WHERE MessageID = ${messageId}`), 'send-message answers with the new host message id, stored under the key').toBe(`${seeded.ids.work}:10:${keys.send}`);

    expect(changes.reset).toBe(false);
    expect(changes.assignments.find((a) => a.orderAssignmentId === seeded.ids.other), 'the changes since the cursor carry the accept').toMatchObject({ status: 'accepted' });
    expect(changes.messages.map((m) => m.messageId)).toContain(messageId);

    expect(assignmentStatus('other'), 'the host accepted the job').toBe(2);
    expect(messagesByBody(body), 'one host message').toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.ids.work} AND Direction = 20 AND SeenByDriverAt IS NULL`), 'the dispatch thread is seen').toBe(0);
    expect(
      hostValue(`SELECT STRING_AGG(CONCAT(CommandType, ':', LOWER(CONVERT(nvarchar(36), TargetUUID))), ',') WITHIN GROUP (ORDER BY CommandType) FROM app.DriverCommandReceipts WHERE CommandUUID IN ('${keys.accept}', '${keys.seen}', '${keys.send}') AND Accepted = 1`),
      'one receipt per sent key, named after its command, on its target',
    ).toBe(`AcceptAssignmentCommand:${seeded.uuids.other},MarkThreadSeenCommand:${seeded.uuids.work},SendDriverMessageCommand:${seeded.uuids.work}`);
    expect(hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID IN ('${keys.reject}', '${keys.unknown}', '${keys.missing}')`), 'no receipt for the refused operations').toBe(0);
    expect(hostNumber(`SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${seeded.ids.other} AND OrderAssignmentHistoryData LIKE N'%reject%'`), 'the invalid reject changed nothing').toBe(0);

    const again = await driver.apply(batch.slice(0, 3), changes.cursor);
    expect(again.results.map((r) => [r.key, r.status, r.targetId])).toEqual([
      [keys.accept, 'duplicate', seeded.ids.other],
      [keys.seen, 'duplicate', seeded.ids.work],
      [keys.send, 'duplicate', messageId],
    ]);
    expect(messagesByBody(body), 'still one host message').toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID IN ('${keys.accept}', '${keys.seen}', '${keys.send}')`), 'still one receipt per key').toBe(3);
    settled = again.changes.cursor;
  });

  test('HSYNC-09 one send-message key sent through POST api/driver-sync and then driver-message/send makes one host message and one receipt, and the route answers as a replay', async () => {
    const key = randomUUID();
    const body = `${MARKER} idempotent ${Date.now()}`;
    const first = await driver.apply([{ key, type: 'send-message', targetId: seeded.ids.work, messageBody: body }]);
    expect(first.results[0]).toMatchObject({ key, status: 'sent', error: null });
    const messageId = first.results[0].targetId!;
    expect(messageId).toBeGreaterThan(0);

    const routed = await driver.sendMessage(seeded.ids.work, body, key);
    expect(routed.status(), await routed.text()).toBe(200);
    expect(isReplayed(routed), 'Idempotent-Replayed: true').toBe(true);
    expect((await routed.json()).data, 'the replay answers with the stored message').toMatchObject({ messageId, messageBody: body, orderAssignmentId: seeded.ids.work });

    const batchedAgain = await driver.apply([{ key, type: 'send-message', targetId: seeded.ids.work, messageBody: body }]);
    expect(batchedAgain.results[0]).toMatchObject({ key, status: 'duplicate', targetId: messageId });

    expect(messagesByBody(body), 'one host app.Messages row').toBe(1);
    expect(hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(CommandType), ':', MIN(LOWER(CONVERT(nvarchar(36), TargetUUID)))) FROM app.DriverCommandReceipts WHERE CommandUUID = '${key}'`), 'one receipt').toBe(
      `1:SendDriverMessageCommand:${seeded.uuids.work}`,
    );
  });

  test('HSYNC-10 a key reused for another type or another target is 409 on the routes and conflict in the batch, and changes nothing', async () => {
    const key = randomUUID();
    const body = `${MARKER} reused key ${Date.now()}`;
    const sent = await driver.sendMessage(seeded.ids.work, body, key);
    expect(sent.status(), await sent.text()).toBe(200);
    expect(isReplayed(sent)).toBe(false);
    const statusBefore = assignmentStatus('edit');

    const otherType = await driver.apply([{ key, type: 'accept-assignment', targetId: seeded.ids.edit }]);
    expect(otherType.results[0]).toMatchObject({ key, status: 'conflict' });
    expect(otherType.results[0].error).toBeTruthy();
    const otherTypeRoute = await driver.accept(seeded.ids.edit, key);
    expect(otherTypeRoute.status(), 'the same key on accept-assignment').toBe(409);
    expect(isReplayed(otherTypeRoute)).toBe(false);

    const otherTarget = await driver.sendMessage(seeded.ids.chat, `${body} elsewhere`, key);
    expect(otherTarget.status(), 'the same key and type on another assignment').toBe(409);
    const otherTargetBatch = await driver.apply([{ key, type: 'send-message', targetId: seeded.ids.chat, messageBody: `${body} elsewhere` }]);
    expect(otherTargetBatch.results[0]).toMatchObject({ key, status: 'conflict' });

    expect(assignmentStatus('edit'), 'the conflicting accept changed nothing').toBe(statusBefore);
    expect(messagesByBody(`${body} elsewhere`), 'no message on the other assignment').toBe(0);
    expect(messagesByBody(body)).toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.DriverCommandReceipts WHERE CommandUUID = '${key}'`), 'still one receipt').toBe(1);
  });

  test('HSYNC-11 an Idempotency-Key that is not a UUID, or the empty UUID, is 400 and nothing is written', async () => {
    const body = `${MARKER} bad key ${Date.now()}`;
    const statusBefore = assignmentStatus('edit');
    for (const bad of ['not-a-uuid', '00000000-0000-0000-0000-000000000000', '12345']) {
      expect((await driver.sendMessage(seeded.ids.work, body, bad)).status(), `driver-message/send with Idempotency-Key: ${bad}`).toBe(400);
      expect((await driver.accept(seeded.ids.edit, bad)).status(), `accept-assignment with Idempotency-Key: ${bad}`).toBe(400);
      expect((await driver.markSeen(seeded.ids.work, bad)).status(), `threads/seen with Idempotency-Key: ${bad}`).toBe(400);
    }
    expect(messagesByBody(body)).toBe(0);
    expect(assignmentStatus('edit')).toBe(statusBefore);
  });

  test('HSYNC-12 a begin-haul in the batch answers with the new trip id, keyed end-haul replays, and a ticket upload stores its photo hash and brings the trip and its assignment back', async () => {
    test.setTimeout(240_000);
    test.skip(
      !hostHasTicketStatusColumn(),
      "The local host database has no app.Tickets.TicketStatusID_FK (QC-724's quarryconnect-api/QuarryConnect.WebApi/Scripts/QC-724 Ticket Status.sql is not applied), so every host trip model answers 500 'Invalid column name'.",
    );
    const acceptKey = randomUUID();
    const accepted = await driver.accept(seeded.ids.work, acceptKey);
    expect(accepted.status(), await accepted.text()).toBe(200);
    expect(isReplayed(accepted)).toBe(false);
    const acceptedAgain = await driver.accept(seeded.ids.work, acceptKey);
    expect(acceptedAgain.status()).toBe(200);
    expect(isReplayed(acceptedAgain), 'accept repeated with its key').toBe(true);
    expect((await acceptedAgain.json()).data).toMatchObject({ orderAssignmentId: seeded.ids.work, status: 'accepted' });
    expect(receipts(`CommandUUID = '${acceptKey}'`)).toBe(1);

    const beginKey = randomUUID();
    const begin = await driver.apply([{ key: beginKey, type: 'begin-haul', targetId: seeded.ids.work, isOfflineSync: false }]);
    expect(begin.results[0], begin.results[0].error ?? '').toMatchObject({ key: beginKey, status: 'sent' });
    tripId = begin.results[0].targetId!;
    expect(hostValue(`SELECT CONCAT(OrderAssignmentID_FK, ':', Status, ':', LOWER(CONVERT(nvarchar(36), TripUUID))) FROM app.Trips WHERE TripID = ${tripId}`), 'the result names the new host trip').toBe(`${seeded.ids.work}:20:${beginKey}`);
    expect(begin.changes.trips.map((t) => t.tripId)).toContain(tripId);

    const endKey = randomUUID();
    const end = await driver.endHaul(tripId, endKey);
    expect(end.status(), await end.text()).toBe(200);
    expect(isReplayed(end)).toBe(false);
    const endAgain = await driver.endHaul(tripId, endKey);
    expect(endAgain.status(), 'end-haul repeated with its key').toBe(200);
    expect(isReplayed(endAgain)).toBe(true);
    expect(hostNumber(`SELECT Status FROM app.Trips WHERE TripID = ${tripId}`), 'the trip is Complete').toBe(30);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${seeded.ids.work}`), 'one trip').toBe(1);
    const beforeUpload = (await driver.changes(settled)).cursor;

    const file: TicketFile = { name: 'e2e-qc829h-ticket.jpg', mimeType: 'image/jpeg', buffer: fs.readFileSync(TICKET_JPEG) };
    const uploadKey = randomUUID();
    const upload = await driver.uploadTicket(tripId, file, { key: uploadKey, sha256: sha256(file.buffer) });
    if (upload.status() >= 500) {
      const reason = await upload.text();
      test.info().annotations.push({ type: 'skip', description: `The host could not store the photo (${upload.status()}: ${reason.slice(0, 200)}); the upload replay was not verified.` });
      test.skip(true, `The local host S3 bucket refused the upload (${upload.status()}).`);
    }
    expect(upload.status(), await upload.text()).toBe(200);
    expect(isReplayed(upload)).toBe(false);
    expect((await upload.json()).data).toMatchObject({ tripId, orderAssignmentId: seeded.ids.work });
    expect(hostNumber(`SELECT TicketID_FK FROM app.Trips WHERE TripID = ${tripId}`), 'the trip has a ticket').toBeGreaterThan(0);
    uploaded = file.buffer;
    expect(
      hostValue(`SELECT CONCAT(COUNT(*), ':', MIN(CommandType), ':', MIN(RTRIM(ContentHash))) FROM app.DriverCommandReceipts WHERE CommandUUID = '${uploadKey}'`),
      'the upload receipt keeps the photo hash',
    ).toBe(`1:TicketImageUploadedCommand:${sha256(file.buffer)}`);

    const delta = await driver.changes(beforeUpload);
    expect(delta.trips.map((t) => t.tripId), 'the changed ticket comes back as its trip').toContain(tripId);
    expect(delta.trips.find((t) => t.tripId === tripId)!.ticketId).toBeTruthy();
    expect(delta.assignments.map((a) => a.orderAssignmentId), 'the changed trip brings its assignment').toContain(seeded.ids.work);
    settled = delta.cursor;
  });

  test('HSYNC-13 the same photo again is a replay with no second receipt, with a new key and the hash or with no headers, and a wrong or non-hex hash is 400', async () => {
    test.setTimeout(120_000);
    test.skip(!uploaded, 'HSYNC-12 did not upload a photo (skipped or failed).');
    const file: TicketFile = { name: 'e2e-qc829h-ticket-again.jpg', mimeType: 'image/jpeg', buffer: uploaded! };
    const tripUuid = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), TripUUID)) FROM app.Trips WHERE TripID = ${tripId}`)!;
    const uploadReceipts = () => receipts(`CommandType = N'TicketImageUploadedCommand' AND TargetUUID = '${tripUuid}'`);
    const ticketsBefore = hostNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TripID_FK = ${tripId}`);
    expect(uploadReceipts()).toBe(1);

    for (const [label, options] of [
      ['a new key with the same X-Content-SHA256', { key: randomUUID(), sha256: sha256(uploaded!) }],
      ['the same photo with no headers (the server hashes it)', {}],
    ] as const) {
      const again = await driver.uploadTicket(tripId, file, options);
      expect(again.status(), `${label}: ${await again.text()}`).toBe(200);
      expect(isReplayed(again), `${label}: Idempotent-Replayed`).toBe(true);
      expect((await again.json()).data, label).toMatchObject({ tripId });
    }

    const other = Buffer.concat([uploaded!, Buffer.from(MARKER)]);
    expect((await driver.uploadTicket(tripId, file, { key: randomUUID(), sha256: sha256(other) })).status(), 'a hash of other bytes').toBe(400);
    expect((await driver.uploadTicket(tripId, file, { sha256: 'abc123' })).status(), 'a hash that is not 64 hex characters').toBe(400);
    expect((await driver.uploadTicket(tripId, file, { sha256: 'z'.repeat(64) })).status(), 'a 64-character hash that is not hex').toBe(400);
    expect(uploadReceipts(), 'still one upload receipt').toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Tickets WHERE TripID_FK = ${tripId}`), 'no second ticket').toBe(ticketsBefore);
  });
});
