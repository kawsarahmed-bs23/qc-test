import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@fixtures/pageFixtures';
import { env, TEST_DATA_DIR } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb, queryDriversDb, querySingleValue } from '@utils/localDb';
import { HostDriversMode, type DriversMode } from '@api/sms-routing.api';
import { HostAssignmentsApi } from '@api/host-assignments.api';
import { HostDriverEventsApi } from '@api/driver-events.api';
import { PasswordGrantApi, decodeJwt, isDriversApiReachable } from '@api/password-grant.api';
import { DriverTicketSubmitApi, type GpsPing } from '@api/ticket-submit.api';
import { HOST_HEADER } from '@api/drivers-mirror.api';
import {
  Qc913Data,
  HostUserInvitesApi,
  identityAcceptsLink,
  inviteEmailTo,
  INVITE_ROW_STATUS,
  INVITE_SENT_MESSAGE,
  type InviteEmail,
} from '@api/user-invites.api';
import {
  DFLOW_NOTES,
  DflowData,
  DflowHostAdminApi,
  dflowEmail,
  driversIsMigrated,
  driversNumber,
  hostNumber,
  queuesDrained,
  removeDflowData,
  seedDflowWorld,
  waitForQueues,
  type DflowWorld,
} from '@api/driver-flows.api';
import { HOST_KEY_ALREADY_REGISTERED, hostKeyStatus, registerHostKey } from '@api/invite-readiness.api';
import { removeTestInviteKeys } from '@api/user-invites.api';
import { canUseAdminApi } from '@api/admin.api';
import { MailSink } from '@pages/host-password-link.page';
import { InviteeBrowser } from '@pages/user-invites.page';

const SOURCE_ORDER_ID = 26;
const LOADS = 3;
const DEVICE = 'e2e-dflow-device';
const QUEUE = { timeout: 30_000, intervals: [500, 1_000, 2_000] };
const LINK = { timeout: 90_000, intervals: [1_000, 2_000, 5_000] };
const KEY_CACHE = { timeout: 400_000, intervals: [5_000, 10_000] };
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');
const PERSON = { email: dflowEmail('driver'), firstName: 'Dora', lastName: 'Flow' };

function hostToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
}

function hostValue(query: string): string | null {
  return querySingleValue(query);
}

function driversValue(query: string): string | null {
  return queryDriversDb(query);
}

function secondsAgo(seconds: number): string {
  return new Date(Math.floor((Date.now() - seconds * 1_000) / 1_000) * 1_000).toISOString();
}

function newPassword(): string {
  return `Dfl!${randomUUID().replace(/-/g, '').slice(0, 12)}Aa1`;
}

function assignmentStatus(id: number): number {
  return hostNumber(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

test.describe('Driver flows: registration by invite and a three-load job hauled through the Drivers API', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
  test.skip(!env.appApiUrl || !env.driversApiUrl || !env.mobileClientId, 'Needs APP_API_URL, DRIVERS_API_URL and MOBILE_CLIENT_ID.');
  test.skip(!env.appAdmin, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD.');
  test.skip(!canUseAdminApi(), 'Needs ADMIN_API_URL to register the host invite key.');

  let admin: DflowHostAdminApi;
  let invites: HostUserInvitesApi;
  let assignments: HostAssignmentsApi;
  let events: HostDriverEventsApi;
  let mode: HostDriversMode;
  let originalMode: DriversMode | null = null;
  let registeredHere = false;
  let world: DflowWorld;
  let hostUuid = '';
  let batchMark = '0';
  let driver: DriverTicketSubmitApi;
  let passwords: PasswordGrantApi;
  const person: { userId: string; sub: string; mail?: InviteEmail; password: string; token: string } = { userId: '', sub: '', password: newPassword(), token: '' };
  const job = { id: 0, uuid: '', trips: [] as { uuid: string; ticketUuid: string; ticketNumber: string }[] };
  const photo = fs.existsSync(TICKET_JPEG) ? fs.readFileSync(TICKET_JPEG) : Buffer.alloc(0);

  const cleanUp = () => {
    const removed = removeDflowData(batchMark);
    expect(removed.host, 'host rows removed').toMatch(/left=0;leftInvites=0;leftNotifications=0;leftOrganisations=0;leftAssignments=0;leftOrders=0/);
    expect(removed.identity, 'Identity logins removed').toMatch(/left=0/);
    if (removed.drivers !== null) expect(removed.drivers, 'DRIVERS rows removed').toMatch(/leftLinks=0;leftAssignments=0/);
  };

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    test.skip(!(await MailSink.isListening()), `The SMTP sink is not listening on 127.0.0.1:${env.smtpSinkPort}.`);
    test.skip(!(await isDriversApiReachable(context)), 'The drivers API (DRIVERS_API_URL) is not running.');
    test.skip(!Qc913Data.hostHasTable('app.UserInvites'), 'The host database has no app.UserInvites (QC-913).');
    test.skip(!Qc913Data.sinkIsConfigured(), `EmailSettings MailServer/MailPort do not point at the SMTP sink 127.0.0.1:${env.smtpSinkPort}.`);
    hostUuid = (hostValue(`SELECT LOWER(PropertyValue) FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND PropertyName = N'HostUuid'`) ?? '').trim();
    test.skip(!hostUuid, 'The host has no Messaging:HostUuid.');
    test.skip(
      driversValue(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`) !== '1',
      'The host is not an active host in DRIVERS.',
    );
    test.skip(!driversIsMigrated(), 'DRIVERS_SQL_DATABASE is not migrated to the one-list schema with app.TripGps (QC-902 027-030, QC-873).');
    test.skip(!fs.existsSync(TICKET_JPEG), 'test-data/qc803/logo-solid.jpg is missing.');

    batchMark = hostValue(`SELECT ISNULL(MAX(TicketBatchID), 0) FROM app.TicketBatches`) ?? '0';
    removeDflowData(batchMark);
    world = seedDflowWorld(SOURCE_ORDER_ID, hostToday());

    const keyState = await hostKeyStatus(context, hostUuid);
    test.skip(keyState.state === 'not-set-up' || keyState.state === 'unreachable', `The host reports invite key state ${keyState.state}.`);
    if (keyState.state === 'not-registered') {
      const registered = await registerHostKey(context, hostUuid);
      expect(registered.status, registered.text).toBe(200);
      registeredHere = true;
      expect(await hostKeyStatus(context, hostUuid)).toEqual({ state: 'registered', kid: keyState.kid });
      const again = await registerHostKey(context, hostUuid);
      expect(again.text).toContain(HOST_KEY_ALREADY_REGISTERED);
    }

    mode = new HostDriversMode(context);
    originalMode = mode.current();
    await mode.set('On');

    admin = new DflowHostAdminApi(context);
    expect(await admin.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the host admin signs in to the host API').toBe(200);
    invites = new HostUserInvitesApi(context).withToken(admin.bearer());
    assignments = new HostAssignmentsApi(context);
    events = new HostDriverEventsApi(context);
    expect(await events.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    passwords = new PasswordGrantApi(context);
  });

  test.afterAll(async () => {
    try {
      await waitForQueues();
    } finally {
      try {
        if (originalMode !== null && mode) await mode.set(originalMode);
      } finally {
        try {
          if (world) cleanUp();
        } finally {
          if (registeredHere) expect(removeTestInviteKeys()).toMatch(/left=0/);
        }
      }
    }
  });

  test('DFLOW-01 the Admin creates a Driver user on a truck with no password: 201, a host user with the Driver role and no Identity login yet', async () => {
    const created = await admin.createDriver({ ...PERSON, truckId: world.truckId });
    expect(created.status, created.text).toBe(201);
    person.userId = created.data!;
    expect(DflowData.hostUser(PERSON.email)).toMatchObject({ id: person.userId, userUuid: null, hasPassword: false, isActive: true, role: 'Driver', organisationId: world.truckId });
    expect(DflowData.identityUserCount(PERSON.email), 'Identity has no login for the new user').toBe(0);
  });

  test('DFLOW-02 Send invite stores an invite row and emails the Identity /invite link for a driver', async () => {
    expect(person.userId, 'DFLOW-01 created the user').not.toBe('');
    const since = MailSink.mark();
    const sent = await invites.sendInvite('manageusers', person.userId);
    expect(sent.status, sent.text).toBe(200);
    person.mail = await inviteEmailTo(PERSON.email, since);
    expect(person.mail.link.payload.user_type).toBe('driver');
    expect(person.mail.acceptUrl).toContain(`${env.identityUrl}/invite?t=`);
    expect(DflowData.invites(person.userId)).toEqual([expect.objectContaining({ uuid: person.mail.link.payload.jti, status: INVITE_ROW_STATUS.sent, accepted: null })]);
    expect(INVITE_SENT_MESSAGE).toContain('Invite sent');
  });

  test('DFLOW-03 accepting as a new login on Identity records the answer: host UserUUID = the Identity sub, invite accepted', async ({ browser, request }) => {
    test.setTimeout(480_000);
    expect(person.mail, 'DFLOW-02 sent the invite').toBeTruthy();
    await expect
      .poll(() => identityAcceptsLink(request, new URL(person.mail!.acceptUrl).searchParams.get('t')!), {
        message: 'Identity has loaded the host invite public key',
        ...KEY_CACHE,
      })
      .toBe(true);
    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.acceptAsNew(person.mail!.acceptUrl, { ...PERSON, password: person.password });
      expect(outcome.status, 'the host recorded the answer').toBe('recorded');
    } finally {
      await invitee.close();
    }
    person.sub = DflowData.identityUserUuid(PERSON.email) ?? '';
    expect(person.sub).toMatch(/^[0-9a-f-]{36}$/);
    expect(DflowData.hostUser(PERSON.email)).toMatchObject({ id: person.userId, userUuid: person.sub });
    expect(DflowData.invites(person.userId)).toEqual([expect.objectContaining({ status: INVITE_ROW_STATUS.accepted, accepted: person.sub })]);
  });

  test('DFLOW-04 DRIVERS gets one active host link for the driver and the host log shows LinkEstablished', async () => {
    expect(person.sub, 'DFLOW-03 linked the user').not.toBe('');
    await expect.poll(() => DflowData.activeLinks(hostUuid, person.sub), { message: 'DRIVERS links the driver to the host', ...LINK }).toBe(1);
    if (env.hostApiLog) {
      await expect
        .poll(() => Qc913Data.hostLogContains(`Drivers linked invite ${person.mail!.link.payload.jti}`), { message: 'the host log shows LinkEstablished', timeout: 60_000 })
        .toBe(true);
    } else {
      test.info().annotations.push({ type: 'skipped check', description: 'HOST_API_LOG is not set, so LinkEstablished in the host log was not checked.' });
    }
  });

  test('DFLOW-05 the new driver signs in with the mobile client (password grant) and gets a Drivers API token for that Identity user', async ({ playwright }) => {
    expect(person.sub, 'DFLOW-03 linked the user').not.toBe('');
    const token = await passwords.passwordGrant(PERSON.email, person.password);
    expect(token.status, `${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
    person.token = token.body.access_token!;
    expect(String(decodeJwt(person.token).claims.sub).toLowerCase()).toBe(person.sub);
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    driver = new DriverTicketSubmitApi(context, person.token);
  });

  test('DFLOW-06 GET /me/hosts lists the host, GET /me with X-Host-Uuid returns the host profile, and an unlinked host UUID is silently ignored', async () => {
    expect(person.token, 'DFLOW-05 signed in').not.toBe('');
    const hosts = await passwords.driversMeHosts(person.token);
    expect(hosts.status(), await hosts.text()).toBe(200);
    const listed = ((await hosts.json()).data?.hosts ?? (await hosts.json()).hosts) as { hostUuid: string; hostName?: string }[];
    expect(listed.map((h) => h.hostUuid.toLowerCase())).toEqual([hostUuid]);

    const linked = await driver.me(hostUuid);
    expect(linked.status(), await linked.text()).toBe(200);
    const model = (await linked.json()).data as { userUuid: string; hostUuid: string | null; host: { hostUuid: string; truck?: unknown } | null; hostDataAvailable: boolean };
    expect(model.userUuid.toLowerCase()).toBe(person.sub);
    expect(model.hostUuid?.toLowerCase()).toBe(hostUuid);
    expect(model.host?.hostUuid.toLowerCase()).toBe(hostUuid);

    const unlinked = await driver.me(randomUUID());
    expect(unlinked.status(), await unlinked.text()).toBe(200);
    const ignored = (await unlinked.json()).data as { hostUuid: string | null; host: unknown };
    expect({ hostUuid: ignored.hostUuid, host: ignored.host }, 'an unlinked X-Host-Uuid is ignored: no host, no error').toEqual({ hostUuid: null, host: null });

    const withoutHeader = await driver.me();
    expect(((await withoutHeader.json()).data as { hostUuid: string | null }).hostUuid, 'without the header /me names no host').toBeNull();
    expect(HOST_HEADER).toBe('X-Host-Uuid');
  });

  test('DFLOW-10 the Admin assigns the driver three loads on the truck: 201, a host assignment for the driver', async () => {
    expect(person.sub, 'flow 1 ran').not.toBe('');
    const created = await assignments.create({
      orderId: world.orderId,
      assignmentDate: hostToday(),
      vendorId: world.vendorId,
      truckId: world.truckId,
      driverUserId: person.userId,
      truckCount: null,
      loadsAssigned: LOADS,
      notes: `${DFLOW_NOTES} work`,
    });
    expect(created.status, created.text).toBe(201);
    job.id = Number(created.data);
    job.uuid = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${job.id}`)!;
    expect(hostNumber(`SELECT LoadsAssigned FROM app.OrderAssignments WHERE OrderAssignmentID = ${job.id}`)).toBe(LOADS);
  });

  test('DFLOW-11 JobOffered reaches DRIVERS, and GET /sync, POST my-assignments and GET details all show the offer', async () => {
    expect(job.uuid, 'DFLOW-10 made the assignment').not.toBe('');
    await expect
      .poll(() => driversValue(`SELECT CONCAT(Status, '|', LoadsAssigned) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${job.uuid}' AND DriverUserUUID = '${person.sub}'`), {
        message: 'JobOffered reaches DRIVERS',
        ...QUEUE,
      })
      .toBe(`1|${LOADS}`);

    const synced = await driver.send({ method: 'GET', path: '/sync' });
    expect(synced.status(), await synced.text()).toBe(200);
    const payload = (await synced.json()).data as { assignments: { orderAssignmentUuid: string }[] };
    expect(payload.assignments.map((a) => a.orderAssignmentUuid.toLowerCase())).toContain(job.uuid);

    const listed = await driver.assignments();
    expect(listed.map((a) => a.orderAssignmentUuid.toLowerCase())).toContain(job.uuid);

    const details = await driver.details(job.uuid);
    expect(details.status(), await details.text()).toBe(200);
    expect(((await details.json()).data as { status: string; loadsAssigned: number }).loadsAssigned).toBe(LOADS);
  });

  test('DFLOW-12 accept-assignment is 202 and the host assignment becomes Accepted with a history row', async () => {
    expect(job.uuid, 'DFLOW-10 made the assignment').not.toBe('');
    const accepted = await driver.accept(job.uuid);
    expect(accepted.status(), await accepted.text()).toBe(202);
    await expect.poll(() => assignmentStatus(job.id), { message: 'JobAccepted reaches the host', ...QUEUE }).toBe(2);
    expect(hostNumber(`SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${job.id}`), 'the host keeps a history of the assignment').toBeGreaterThan(0);
  });

  for (let load = 1; load <= LOADS; load++) {
    test(`DFLOW-1${2 + load} load ${load} of ${LOADS}: begin-haul, GPS points, ticket photo, Submit and end-haul each reach the host`, async () => {
      test.setTimeout(240_000);
      expect(job.uuid, 'DFLOW-10 made the assignment').not.toBe('');
      const trip = { uuid: randomUUID(), ticketUuid: randomUUID(), ticketNumber: `DFL${Date.now() % 1_000_000}${load}` };
      job.trips.push(trip);

      const begun = await driver.beginHaulWithTrip(job.uuid, trip.uuid);
      expect(begun.status(), await begun.text()).toBe(202);
      await expect.poll(() => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE TripUUID = '${trip.uuid}'`), { message: 'TripStarted creates the host trip', ...QUEUE }).toBe(1);
      await expect.poll(() => assignmentStatus(job.id), { message: 'the host assignment is Running', ...QUEUE }).toBe(4);

      const pings: GpsPing[] = [0, 1, 2].map((i) => ({
        TripGpsUUID: randomUUID(),
        lat: 29.989 + i / 1000,
        lng: -97.877,
        accuracyMeters: 5,
        isMoving: true,
        recordedAt: secondsAgo(30 - i * 10),
        tripUuid: trip.uuid,
        orderAssignmentUuid: job.uuid,
      }));
      const pinged = await driver.gpsPings(pings, DEVICE);
      expect(pinged.status(), await pinged.text()).toBe(202);
      for (const ping of pings) {
        await expect
          .poll(() => hostNumber(`SELECT COUNT(*) FROM app.TripGps WHERE TripGpsUUID = '${ping.TripGpsUUID}'`), {
            message: `GpsTraceUploaded stores the host copy; DRIVERS row: ${driversValue(`SELECT CONCAT(IsFlagged, '|', ISNULL(FlagReason, '-'), '|', CASE WHEN SentAt IS NULL THEN 'unsent' ELSE 'sent' END) FROM app.TripGps WHERE TripGpsUUID = '${ping.TripGpsUUID}'`)}`,
            timeout: 60_000,
            intervals: [500, 1_000, 2_000],
          })
          .toBe(1);
      }

      const uploaded = await driver.upload(trip.uuid, { name: 'e2e-dflow-ticket.jpg', mimeType: 'image/jpeg', buffer: photo }, { ticketUuid: trip.ticketUuid });
      test.info().annotations.push({ type: 'upload', description: `load ${load}: ${uploaded.status()} ${(await uploaded.text()).slice(0, 200)}` });
      expect(uploaded.status(), await uploaded.text()).toBe(202);
      const status = await driver.ticketStatus(trip.uuid);
      expect(status.status(), await status.text()).toBe(200);
      test.info().annotations.push({ type: 'ticket status', description: `load ${load}: ${JSON.stringify((await status.json()).data).slice(0, 300)}` });

      const submitted = await driver.submit(trip.uuid, { ticketNumber: trip.ticketNumber, ticketDate: hostToday(), ticketQuantity: 10 + load });
      expect(submitted.status(), await submitted.text()).toBe(202);
      await expect
        .poll(
          () => hostValue(`SELECT CONCAT(COUNT(*), '|', MIN(TicketNumber)) FROM app.Tickets WHERE TicketUUID = '${trip.ticketUuid}' AND Active = 1`),
          { message: 'TicketSubmitted makes the host ticket', timeout: 60_000, intervals: [1_000, 2_000, 5_000] },
        )
        .toBe(`1|${trip.ticketNumber}`);

      const ended = await driver.endHaul(trip.uuid);
      expect(ended.status(), await ended.text()).toBe(202);
      await expect
        .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${trip.uuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE })
        .toBe(30);
      await waitForQueues();
      expect(queuesDrained(), 'both queues are empty after the load').toBe(true);
      expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${job.id}`), 'the host has one trip per hauled load').toBe(load);
    });
  }

  test('DFLOW-16 after the third load Finish Day is 202: the assignment is Complete (5) in DRIVERS and on the host', async () => {
    expect(job.trips.length, 'all loads were hauled').toBe(LOADS);
    await waitForQueues();
    expect(assignmentStatus(job.id), 'end-haul alone leaves the assignment Running').toBe(4);
    const finished = await driver.finishDay(job.uuid, `${DFLOW_NOTES} done`);
    expect(finished.status(), await finished.text()).toBe(202);
    expect(driversValue(`SELECT Status FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${job.uuid}'`), 'DRIVERS assignment').toBe('5');
    await expect.poll(() => assignmentStatus(job.id), { message: 'DayFinished reaches the host', ...QUEUE }).toBe(5);
    const again = await driver.finishDay(job.uuid);
    expect(again.status(), 'finish-day on a Complete assignment').toBe(202);
  });

  test('DFLOW-17 my-tickets lists the three tickets and reprocess answers for a submitted ticket', async () => {
    expect(job.trips.length).toBe(LOADS);
    const listed = await driver.myTickets();
    expect(listed.status(), await listed.text()).toBe(200);
    const text = JSON.stringify((await listed.json()).data).toLowerCase();
    for (const trip of job.trips) expect(text, `my-tickets shows ${trip.ticketUuid}`).toContain(trip.ticketUuid);

    const reprocessed = await driver.reprocessTicket(job.trips[0].uuid);
    test.info().annotations.push({ type: 'reprocess after submit', description: `${reprocessed.status()} ${(await reprocessed.text()).slice(0, 200)}` });
    expect([202, 409]).toContain(reprocessed.status());
  });

  test('DFLOW-18 the message routes: threads, thread, general thread, quick replies, send reaches host app.Messages, seen', async () => {
    expect(job.uuid, 'DFLOW-10 made the assignment').not.toBe('');
    const threads = await driver.threads();
    expect(threads.status(), await threads.text()).toBe(200);
    const thread = await driver.thread(job.uuid);
    expect(thread.status(), await thread.text()).toBe(200);
    const general = await driver.send({ method: 'GET', path: `/driver-message/threads/general?HostUUID=${hostUuid}` });
    expect(general.status(), await general.text()).toBe(200);
    const replies = await driver.quickReplies(hostUuid);
    expect(replies.status(), await replies.text()).toBe(200);

    const body = `${DFLOW_NOTES} hello ${Date.now()}`;
    const sent = await driver.sendMessage(job.uuid, body);
    expect(sent.status(), await sent.text()).toBe(202);
    await expect
      .poll(() => hostNumber(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${job.id} AND MessageBody = N'${body}'`), {
        message: 'DriverMessageSent reaches host app.Messages',
        ...QUEUE,
      })
      .toBe(1);

    const seen = await driver.markSeen(job.uuid);
    expect(seen.status(), await seen.text()).toBeLessThan(300);
  });

  test('DFLOW-19 GET and PUT /me/settings round-trip (restored) and GET /eula answers', async () => {
    expect(person.token, 'DFLOW-05 signed in').not.toBe('');
    const read = await driver.send({ method: 'GET', path: '/me/settings' });
    test.info().annotations.push({ type: 'GET /me/settings', description: `${read.status()} ${(await read.text()).slice(0, 200)}` });
    expect(read.status(), await read.text()).toBe(200);
    const readBody = await read.text();
    test.info().annotations.push({ type: 'GET /me/settings body', description: readBody.slice(0, 300) });
    const original = JSON.parse(readBody).data as { notifyBySms?: boolean; truckNumber?: string | null };
    const flipped = !(original.notifyBySms ?? false);
    try {
      const written = await driver.send({ method: 'PUT', path: '/me/settings', data: { notifyBySms: flipped } });
      expect(written.status(), await written.text()).toBe(200);
      const writtenBody = await written.text();
      expect((JSON.parse(writtenBody).data as { notifyBySms?: boolean }).notifyBySms, `PUT answer: ${writtenBody.slice(0, 300)}`).toBe(flipped);
    } finally {
      const restored = await driver.send({ method: 'PUT', path: '/me/settings', data: { notifyBySms: original.notifyBySms ?? false } });
      expect(restored.status(), await restored.text()).toBe(200);
    }
    const eula = await driver.send({ method: 'GET', path: '/eula' });
    test.info().annotations.push({ type: 'GET /eula', description: `${eula.status()}` });
    expect([200, 404]).toContain(eula.status());
  });

  const extra = {
    edit: { id: 0, uuid: '' },
    sync: { id: 0, uuid: '', tripUuid: '' },
    cancel: { id: 0, uuid: '' },
    reopen: { id: 0, uuid: '', tripUuid: '' },
    ops: { id: 0, uuid: '', tripUuid: '' },
    late: { id: 0, uuid: '', first: '', last: '' },
  };

  const offerExtra = async (target: { id: number; uuid: string }, notes: string, loads: number) => {
    const created = await assignments.create({
      orderId: world.orderId,
      assignmentDate: hostToday(),
      vendorId: world.vendorId,
      truckId: world.truckId,
      driverUserId: person.userId,
      truckCount: null,
      loadsAssigned: loads,
      notes: `${DFLOW_NOTES} ${notes}`,
    });
    expect(created.status, created.text).toBe(201);
    target.id = Number(created.data);
    target.uuid = hostValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${target.id}`)!;
    await expect
      .poll(() => driversValue(`SELECT CONCAT(Status, '|', LoadsAssigned) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${target.uuid}'`), {
        message: 'JobOffered reaches DRIVERS',
        ...QUEUE,
      })
      .toBe(`1|${loads}`);
  };

  const haulLoad = async (target: { id: number; uuid: string }): Promise<string> => {
    const tripUuid = randomUUID();
    const begun = await driver.beginHaulWithTrip(target.uuid, tripUuid);
    expect(begun.status(), await begun.text()).toBe(202);
    await expect.poll(() => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE TripUUID = '${tripUuid}'`), { message: 'TripStarted creates the host trip', ...QUEUE }).toBe(1);
    const ended = await driver.endHaul(tripUuid);
    expect(ended.status(), await ended.text()).toBe(202);
    await expect.poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE }).toBe(30);
    return tripUuid;
  };

  const acceptExtra = async (target: { id: number; uuid: string }) => {
    const accepted = await driver.accept(target.uuid);
    expect(accepted.status(), await accepted.text()).toBe(202);
    await expect.poll(() => assignmentStatus(target.id), { message: 'JobAccepted reaches the host', ...QUEUE }).toBe(2);
  };

  const driversTrip = (tripUuid: string) => driversNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`);
  const hostTrip = (tripUuid: string) => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${tripUuid}'`);
  const commandCount = (type: string, key: string) => driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE CommandUUID = '${key}' AND CommandType = '${type}'`);
  const problemNotes = (id: number) => hostNumber(`SELECT COUNT(*) FROM app.TripNotes WHERE OrderAssignmentID_FK = ${id} AND StatusType = 30 AND HowEntered = 20`);
  const completionTimes = (tripUuid: string) =>
    driversValue(`SELECT CONCAT(CONVERT(varchar(33), TripCompletedAt, 126), '|', ISNULL(CONVERT(varchar(33), ReopenUntil, 126), '')) FROM app.Trips WHERE TripUUID = '${tripUuid}'`)!;

  test('DFLOW-20 reopen-haul makes the ended load Active, report-problem makes it Problem with a host note, and finish-day is 409 while a load is Active', async () => {
    test.setTimeout(240_000);
    await offerExtra(extra.reopen, 'reopen', 2);
    await acceptExtra(extra.reopen);
    extra.reopen.tripUuid = await haulLoad(extra.reopen);

    const reopened = await driver.reopenHaul(extra.reopen.tripUuid);
    expect(reopened.status(), await reopened.text()).toBe(202);
    expect(driversTrip(extra.reopen.tripUuid), 'DRIVERS trip is Active').toBe(20);
    await expect.poll(() => hostTrip(extra.reopen.tripUuid), { message: 'TripReopened reaches the host', ...QUEUE }).toBe(20);

    const early = await driver.finishDay(extra.reopen.uuid);
    expect(early.status(), await early.text()).toBe(409);
    expect(await early.text()).toContain('End the load first.');
    expect(driversValue(`SELECT Status FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${extra.reopen.uuid}'`), 'the assignment is still Running').toBe('4');

    const reported = await driver.reportProblem(extra.reopen.tripUuid, `${DFLOW_NOTES} problem`);
    expect(reported.status(), await reported.text()).toBe(202);
    expect(driversTrip(extra.reopen.tripUuid), 'DRIVERS trip is Problem').toBe(40);
    await expect.poll(() => hostTrip(extra.reopen.tripUuid), { message: 'ProblemReported reaches the host', ...QUEUE }).toBe(40);
    await expect.poll(() => problemNotes(extra.reopen.id), { message: 'the host keeps a Problem trip note', ...QUEUE }).toBe(1);

    const closed = await driver.endHaul(extra.reopen.tripUuid);
    expect(closed.status(), await closed.text()).toBe(202);
    await expect.poll(() => hostTrip(extra.reopen.tripUuid), { message: 'the problem load ends on the host', ...QUEUE }).toBe(30);
    await waitForQueues();
  });

  test('DFLOW-22 POST /sync reopen-haul, report-problem and finish-day are sent once and duplicate with the same key: one command per key and one host effect', async () => {
    test.setTimeout(240_000);
    await offerExtra(extra.ops, 'ops', 1);
    await acceptExtra(extra.ops);
    extra.ops.tripUuid = await haulLoad(extra.ops);

    const reopenKey = randomUUID();
    const reopenOp = { key: reopenKey, type: 'reopen-haul', targetUuid: extra.ops.tripUuid };
    const [reopened] = await driver.syncOperations([reopenOp]);
    expect(reopened, 'reopen-haul in /sync').toMatchObject({ key: reopenKey, status: 'sent' });
    await expect.poll(() => hostTrip(extra.ops.tripUuid), { message: 'TripReopened reaches the host', ...QUEUE }).toBe(20);
    const [reopenAgain] = await driver.syncOperations([reopenOp]);
    expect(reopenAgain.status, 'the same reopen-haul key again').toBe('duplicate');

    const problemKey = randomUUID();
    const problemOp = { key: problemKey, type: 'report-problem', targetUuid: extra.ops.tripUuid, notes: `${DFLOW_NOTES} sync problem` };
    const [reported] = await driver.syncOperations([problemOp]);
    expect(reported, 'report-problem in /sync').toMatchObject({ key: problemKey, status: 'sent' });
    await expect.poll(() => hostTrip(extra.ops.tripUuid), { message: 'ProblemReported reaches the host', ...QUEUE }).toBe(40);
    const [problemAgain] = await driver.syncOperations([problemOp]);
    expect(problemAgain.status, 'the same report-problem key again').toBe('duplicate');

    const closed = await driver.endHaul(extra.ops.tripUuid);
    expect(closed.status(), await closed.text()).toBe(202);
    await expect.poll(() => hostTrip(extra.ops.tripUuid), { message: 'the problem load ends on the host', ...QUEUE }).toBe(30);

    const finishKey = randomUUID();
    const finishOp = { key: finishKey, type: 'finish-day', targetUuid: extra.ops.uuid, notes: `${DFLOW_NOTES} sync finish` };
    const [finished] = await driver.syncOperations([finishOp]);
    expect(finished, 'finish-day in /sync').toMatchObject({ key: finishKey, status: 'sent' });
    await expect.poll(() => assignmentStatus(extra.ops.id), { message: 'DayFinished reaches the host', ...QUEUE }).toBe(5);
    const [finishAgain] = await driver.syncOperations([finishOp]);
    expect(finishAgain.status, 'the same finish-day key again').toBe('duplicate');

    await waitForQueues();
    expect(commandCount('reopen-haul', reopenKey), 'one reopen-haul command').toBe(1);
    expect(commandCount('report-problem', problemKey), 'one report-problem command').toBe(1);
    expect(commandCount('finish-day', finishKey), 'one finish-day command').toBe(1);
    expect(problemNotes(extra.ops.id), 'one host Problem note after the replays').toBe(1);
    expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${extra.ops.id}`), 'one host trip').toBe(1);
  });

  test('DFLOW-23 reopen-haul is 409 on a load that has a later load and on a load ended more than 15 minutes ago, and nothing changes', async () => {
    test.setTimeout(240_000);
    await offerExtra(extra.late, 'late', 2);
    await acceptExtra(extra.late);
    extra.late.first = await haulLoad(extra.late);
    extra.late.last = await haulLoad(extra.late);

    const later = await driver.reopenHaul(extra.late.first);
    expect(later.status(), await later.text()).toBe(409);
    expect(await later.text()).toContain('has already started');
    expect(driversTrip(extra.late.first), 'the first load stays Complete').toBe(30);

    const original = completionTimes(extra.late.last);
    const [completedAt, reopenUntil] = original.split('|');
    try {
      driversValue(`UPDATE app.Trips SET TripCompletedAt = DATEADD(minute, -20, TripCompletedAt), ReopenUntil = CASE WHEN ReopenUntil IS NULL THEN NULL ELSE DATEADD(minute, -20, ReopenUntil) END WHERE TripUUID = '${extra.late.last}'`);
      const expired = await driver.reopenHaul(extra.late.last);
      expect(expired.status(), await expired.text()).toBe(409);
      expect(await expired.text()).toContain('more than 15 minutes ago');
      expect(driversTrip(extra.late.last), 'the last load stays Complete').toBe(30);
    } finally {
      driversValue(`UPDATE app.Trips SET TripCompletedAt = '${completedAt}', ReopenUntil = ${reopenUntil ? `'${reopenUntil}'` : 'NULL'} WHERE TripUUID = '${extra.late.last}'`);
    }
    expect(completionTimes(extra.late.last), 'the completion time is restored').toBe(original);
    expect(hostTrip(extra.late.last), 'the host trip stays Complete').toBe(30);
  });

  test('DFLOW-30 a Host edit of the assignment (PUT api/assignment/{id}, loads 1 to 2) reaches DRIVERS and the driver app', async () => {
    expect(person.sub, 'flow 1 ran').not.toBe('');
    await offerExtra(extra.edit, 'edit', 1);
    const updated = await assignments.update(extra.edit.id, {
      orderId: world.orderId,
      assignmentDate: hostToday(),
      vendorId: world.vendorId,
      truckId: world.truckId,
      driverUserId: person.userId,
      truckCount: null,
      loadsAssigned: 2,
      notes: `${DFLOW_NOTES} edit`,
    });
    expect(updated.status, updated.text).toBeLessThan(300);
    await expect
      .poll(() => driversValue(`SELECT LoadsAssigned FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${extra.edit.uuid}'`), {
        message: 'JobChanged reaches DRIVERS',
        ...QUEUE,
      })
      .toBe('2');
    const details = await driver.details(extra.edit.uuid);
    expect(details.status(), await details.text()).toBe(200);
    expect(((await details.json()).data as { loadsAssigned: number }).loadsAssigned).toBe(2);
  });

  test('DFLOW-31 a Host dispatcher message reaches the driver: DRIVERS driver-message/threads shows it unseen on the assignment the Host attached it to', async () => {
    expect(extra.edit.uuid, 'DFLOW-30 made the assignment').not.toBe('');
    const body = `${DFLOW_NOTES} dispatch ${Date.now()}`;
    const sent = await events.sendDispatchMessage(person.userId, extra.edit.id, body);
    expect(sent.status(), await sent.text()).toBe(200);
    const stored = hostValue(
      `SELECT CONCAT(LOWER(CONVERT(nvarchar(36), m.MessageUUID)), '|', LOWER(CONVERT(nvarchar(36), a.OrderAssignmentUUID))) FROM app.Messages m JOIN app.OrderAssignments a ON a.OrderAssignmentID = m.OrderAssignmentID_FK WHERE m.DriverUserID_FK = N'${person.userId}' AND m.MessageBody = N'${body}'`,
    );
    expect(stored, 'the host stored the dispatcher message').not.toBeNull();
    const [messageUuid, assignmentUuid] = stored!.split('|');
    test.info().annotations.push({
      type: 'attached to',
      description: `the host attached the message to ${assignmentUuid === extra.edit.uuid ? 'the named assignment' : 'the main job (the current assignment of the driver), not the named one'}`,
    });
    await expect
      .poll(() => driversNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageUUID = '${messageUuid}' AND IsFromDispatch = 1`), {
        message: 'MessageSent reaches DRIVERS',
        ...QUEUE,
      })
      .toBe(1);
    const list = await driver.threadList();
    expect(list.threads.find((t) => t.orderAssignmentUuid.toLowerCase() === assignmentUuid)?.unseenCount, 'the thread list shows the message as unseen').toBeGreaterThan(0);
    const thread = await driver.thread(assignmentUuid);
    expect(thread.status(), await thread.text()).toBe(200);
    expect(JSON.stringify((await thread.json()).data)).toContain(body);
  });

  test('DFLOW-32 POST /sync replay: a keyed begin-haul and end-haul are applied once; the same key again is a duplicate and adds nothing on either side', async () => {
    test.setTimeout(240_000);
    await offerExtra(extra.sync, 'sync', 1);
    const accepted = await driver.accept(extra.sync.uuid);
    expect(accepted.status(), await accepted.text()).toBe(202);
    await expect.poll(() => assignmentStatus(extra.sync.id), { message: 'JobAccepted reaches the host', ...QUEUE }).toBe(2);

    const beginKey = randomUUID();
    const beginOp = { key: beginKey, type: 'begin-haul', targetUuid: extra.sync.uuid, isOfflineSync: true, deviceAt: secondsAgo(120) };
    const [begun] = await driver.syncOperations([beginOp]);
    expect(begun, 'begin-haul in /sync').toMatchObject({ key: beginKey, status: 'sent' });
    extra.sync.tripUuid = begun.targetUuid!.toLowerCase();
    await expect
      .poll(() => hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE TripUUID = '${extra.sync.tripUuid}'`), { message: 'TripStarted creates the host trip', ...QUEUE })
      .toBe(1);
    const [beginAgain] = await driver.syncOperations([beginOp]);
    expect(beginAgain.status, 'the same begin-haul key again').toBe('duplicate');

    const endKey = randomUUID();
    const endOp = { key: endKey, type: 'end-haul', targetUuid: extra.sync.tripUuid, isOfflineSync: true, deviceAt: secondsAgo(30) };
    const [ended] = await driver.syncOperations([endOp]);
    expect(ended, 'end-haul in /sync').toMatchObject({ key: endKey, status: 'sent' });
    const [endAgain] = await driver.syncOperations([endOp]);
    expect(endAgain.status, 'the same end-haul key again').toBe('duplicate');

    await expect
      .poll(() => hostNumber(`SELECT Status FROM app.Trips WHERE TripUUID = '${extra.sync.tripUuid}'`), { message: 'TripCompleted reaches the host', ...QUEUE })
      .toBe(30);
    await waitForQueues();
    expect(hostNumber(`SELECT COUNT(*) FROM app.Trips WHERE OrderAssignmentID_FK = ${extra.sync.id}`), 'one host trip after the replays').toBe(1);
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE CommandUUID IN ('${beginKey}', '${endKey}')`), 'one command per key').toBe(2);
  });

  test('DFLOW-33 a Host cancel of an offered assignment (PATCH api/assignment/{id}/status Canceled) reaches DRIVERS as Canceled', async () => {
    await offerExtra(extra.cancel, 'cancel', 1);
    const canceled = await events.setStatus(extra.cancel.id, 'Canceled', `${DFLOW_NOTES} cancel`);
    expect(canceled.status(), await canceled.text()).toBe(200);
    await expect
      .poll(() => driversValue(`SELECT Status FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${extra.cancel.uuid}'`), {
        message: 'JobCanceled reaches DRIVERS',
        ...QUEUE,
      })
      .toBe('8');
  });

  test('DFLOW-34 a second host: the same driver linked to two hosts sees both in /me/hosts and sync', async () => {
    test.skip(true, 'A second host needs its own host API, database and HOST_MASTER row; not cheap to set up here.');
    expect(person.sub).toBeTruthy();
  });

  test('DFLOW-35 a host added to HOST_MASTER gets its DRIVERS host row from the host queue sync, so its first driver invite links with no SQL seed', async () => {
    test.skip(process.env.DRIVERS_API_SQS_MODE !== 'true', 'HostQueueSyncService inserts missing hosts only in SQS mode; the local Drivers API runs on TCP, so the job is not registered (set DRIVERS_API_SQS_MODE=true when it runs on SQS).');
    expect(driversValue(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`)).toBe('1');
    expect(person.sub, 'DFLOW-03 linked the user').not.toBe('');
    expect(DflowData.activeLinks(hostUuid, person.sub)).toBe(1);
  });

  test('DFLOW-21 the throwaway data is removed and nothing is left', async () => {
    await waitForQueues();
    expect(driversNumber(`SELECT COUNT(*) FROM app.DriverCommands WHERE UserUUID = '${person.sub}'`), 'the driver has logged commands before clean-up').toBeGreaterThan(0);
    cleanUp();
    expect(hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE Notes = N'e2e-dflow order'`)).toBe(0);
    expect(DflowData.hostUser(PERSON.email)).toBeNull();
  });
});
