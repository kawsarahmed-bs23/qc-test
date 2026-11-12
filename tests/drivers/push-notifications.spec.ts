import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, canUseDriversDb, driversColumns, queryDriversDb, querySingleValue, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { HostDriverEventsApi } from '@api/driver-events.api';
import { HostAssignmentsApi, type AssignmentSave } from '@api/host-assignments.api';
import { DriverSyncApi, ExpoStubLog } from '@api/driver-sync.api';
import { isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import { env } from '@config/env.config';

const MARKER = 'e2e-qc918';
const ORDER_ID = 26;
const SECOND_ORDER_ID = 25;
const VENDOR_ID = 34;
const TRUCK_ID = 38;
const QUEUE = { timeout: 25_000, intervals: [500, 1_000, 2_000] };
const QUIET_MS = 5_000;
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
const OPEN_APP = { en: 'Open the app to see it.', es: 'Abre la app para verlo.' };

type PushMessage = Record<string, unknown> & { data?: Record<string, unknown> };

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

function driversRow(uuid: string, columns: string): string | null {
  return driversValue(`SELECT CONCAT_WS('|', ${columns}, NULL) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${uuid}'`);
}

function deviceRow(token: string): string | null {
  return driversValue(
    `SELECT CONCAT_WS('|', CAST(Active AS int), ISNULL(LanguageCode, '-'), ISNULL(AppVersion, '-'), CASE WHEN PushDisabledAt IS NULL THEN 'on' ELSE 'disabled' END, UpdatedBy) FROM app.DeviceTokens WHERE Token = ${sqlText(token)}`,
  );
}

function pushDate(isoDate: string, language: 'en' | 'es'): string {
  const [, month, day] = isoDate.split('-').map(Number);
  return language === 'es' ? `${day} ${MONTHS_ES[month - 1]}` : `${MONTHS_EN[month - 1]} ${day}`;
}

function placeName(line: string | null): string {
  return (line ?? '').split(',')[0].trim();
}

function pushBody(text: string): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(' ');
  return collapsed.length <= 150 ? collapsed : `${collapsed.slice(0, 149).trimEnd()}…`;
}

function queuesDrained(): boolean {
  return (
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0
  );
}

function removeAll(): void {
  runDriversSeedScript('drivers-qc918.remove.sql');
  runSeedScript('host-qc918.remove.sql');
}

test.describe(
  'Drivers API shows Job offers and dispatch messages as push notifications in the phone language (QC-918)',
  { tag: ['@write', '@regression'] },
  () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedLocalDb() || !canUseDriversDb(), 'Needs the host and DRIVERS local databases (local only).');
    test.skip(!env.appAdmin || !env.driver, 'Needs APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD and DRIVER_EMAIL / DRIVER_PASSWORD.');
    test.skip(!env.appApiUrl || !env.driversApiUrl, 'Needs APP_API_URL and DRIVERS_API_URL.');
    test.skip(!ExpoStubLog.open(), 'Needs EXPO_STUB_LOG: the log of the local Expo push stub the Drivers API posts to (Push__ExpoUrl).');

    const stub = ExpoStubLog.open()!;
    const run = Date.now();
    const enToken = `ExponentPushToken[${MARKER}-en-${run}]`;
    const esToken = `ExponentPushToken[${MARKER}-es-${run}]`;
    const plainToken = `ExponentPushToken[${MARKER}-plain-${run}]`;
    const goneToken = `ExponentPushToken[${MARKER}-Gone-${run}]`;
    const device = (name: string) => `${MARKER}-${name}-${run}`;

    let host: HostDriverEventsApi;
    let assignments: HostAssignmentsApi;
    let phone: DriverSyncApi;
    let hostUuid = '';
    let hostName = '';
    let driverId = '';
    const offer = { id: 0, uuid: '', date: '' };

    const assignment = (overrides: Partial<AssignmentSave>): AssignmentSave => ({
      orderId: ORDER_ID,
      assignmentDate: hostToday(2),
      vendorId: VENDOR_ID,
      truckId: TRUCK_ID,
      driverUserId: driverId,
      truckCount: null,
      loadsAssigned: 2,
      notes: MARKER,
      ...overrides,
    });

    async function settlePushes(): Promise<void> {
      await expect.poll(queuesDrained, { message: 'both Wolverine queues drain', ...QUEUE }).toBe(true);
      let size = stub.mark();
      let changedAt = Date.now();
      await expect
        .poll(
          () => {
            const now = stub.mark();
            if (now !== size) {
              size = now;
              changedAt = Date.now();
            }
            return Date.now() - changedAt;
          },
          { message: `the Expo stub stays quiet for ${QUIET_MS} ms (past the coalescing window)`, timeout: 40_000, intervals: [500] },
        )
        .toBeGreaterThanOrEqual(QUIET_MS);
    }

    async function onePushEach(mark: number, tokens: string[]): Promise<Record<string, PushMessage>> {
      for (const token of tokens) {
        await expect.poll(() => stub.messagesTo(mark, token).length, { message: `a push reaches ${token}`, ...QUEUE }).toBeGreaterThan(0);
      }
      await settlePushes();
      const pushes: Record<string, PushMessage> = {};
      for (const token of tokens) {
        const messages = stub.messagesTo(mark, token) as PushMessage[];
        expect(messages, `exactly one push to ${token}: ${JSON.stringify(messages)}`).toHaveLength(1);
        pushes[token] = messages[0];
      }
      return pushes;
    }

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(120_000);
      hostUuid = (
        driversValue(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = ${sqlText(env.hostName)} AND Active = 1`) ?? ''
      ).toLowerCase();
      test.skip(!hostUuid, `The host '${env.hostName}' (HOST_NAME) is not an active host in DRIVERS.`);
      hostName = driversValue(`SELECT HostName FROM app.Hosts WHERE HostUUID = '${hostUuid}'`)!;
      test.skip(
        hostNumber(`SELECT COUNT(*) FROM app.Orders WHERE OrderID IN (${ORDER_ID}, ${SECOND_ORDER_ID})`) < 2,
        `Needs orders ${ORDER_ID} and ${SECOND_ORDER_ID} of the local copy.`,
      );

      const probe = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      let accessToken = '';
      try {
        test.skip(!(await isDriversApiReachable(probe)), 'The drivers API (DRIVERS_API_URL) is not running.');
        const hostAnswers = await probe
          .post(`${env.appApiUrl}/api/account/login`, { data: {}, timeout: 10_000 })
          .then((r) => r.status())
          .catch(() => 0);
        test.skip(hostAnswers === 0, 'The host API (APP_API_URL) is not running.');
        const token = await new PasswordGrantApi(probe).passwordGrant(env.driver!.email, env.driver!.password);
        expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
        accessToken = token.body.access_token!;
      } finally {
        await probe.dispose();
      }
      const driverUuid = tokenSubject(accessToken);
      driverId = hostValue(`SELECT Id FROM auth.Users WHERE UserUUID = '${driverUuid}'`) ?? '';
      test.skip(!driverId, 'The DRIVER_EMAIL account (by its UserUUID) is not a host user.');
      test.skip(
        driversNumber(
          `SELECT COUNT(*) FROM app.DriverHostLinks l JOIN app.Hosts h ON h.${driversColumns().hostKey} = l.${driversColumns().host} WHERE l.${driversColumns().user} = ${sqlText(driverUuid)} AND h.HostUUID = '${hostUuid}' AND l.Active = 1`,
        ) === 0,
        'The DRIVER_EMAIL account is not linked to the host in DRIVERS.',
      );

      removeAll();
      phone = new DriverSyncApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), accessToken);
      const hostContext = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      host = new HostDriverEventsApi(hostContext);
      assignments = new HostAssignmentsApi(hostContext);
      expect(await host.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the host admin signs in to the host API').toBe(200);
      expect(await assignments.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    });

    test.afterAll(async () => {
      test.setTimeout(60_000);
      for (let wait = 0; wait < 40 && !queuesDrained(); wait++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      removeAll();
    });

    test('PUSH-01 PUT /devices stores the phone language (en or es, any case) and app version and answers the language, English when none; any other language or a long app version is 400', async () => {
      const en = await phone.registerDevice({ token: enToken, platform: 'ios', deviceId: device('en'), language: 'en', appVersion: '1.4.0-e2e' });
      expect(en.status(), await en.text()).toBe(200);
      expect((await en.json()).data).toMatchObject({ platform: 'ios', deviceId: device('en'), language: 'en' });
      expect(deviceRow(enToken), 'Active | LanguageCode | AppVersion | PushDisabledAt').toMatch(/^1\|en\|1\.4\.0-e2e\|on\|/);

      const es = await phone.registerDevice({ token: esToken, platform: 'android', deviceId: device('es'), language: ' ES ' });
      expect(es.status(), await es.text()).toBe(200);
      expect((await es.json()).data).toMatchObject({ platform: 'android', deviceId: device('es'), language: 'es' });
      expect(deviceRow(esToken)).toMatch(/^1\|es\|-\|on\|/);

      const plain = await phone.registerDevice({ token: plainToken, platform: 'ios', deviceId: device('plain') });
      expect(plain.status(), await plain.text()).toBe(200);
      expect((await plain.json()).data, 'no language is answered as English').toMatchObject({ language: 'en' });
      expect(deviceRow(plainToken), 'no language is stored as NULL').toMatch(/^1\|-\|-\|on\|/);
      expect((await phone.removeDevice(device('plain'))).status(), 'the plain device is removed again so it gets no pushes').toBe(200);

      const badToken = `ExponentPushToken[${MARKER}-bad-${run}]`;
      for (const [label, registration, field] of [
        ['French', { language: 'fr' }, 'Language'],
        ['a language name', { language: 'english' }, 'Language'],
        ['a 51-character app version', { language: 'en', appVersion: 'v'.repeat(51) }, 'AppVersion'],
      ] as const) {
        const refused = await phone.registerDevice({ token: badToken, platform: 'ios', deviceId: device('bad'), ...registration });
        expect(refused.status(), label).toBe(400);
        expect(Object.keys((await refused.json()).validationErrors ?? {}), label).toContain(field);
      }
      expect(deviceRow(badToken), 'no row for a refused registration').toBeNull();
      expect(
        (await phone.registerDevice({ token: badToken, platform: 'ios', deviceId: device('bad'), appVersion: 'v'.repeat(50) })).status(),
        'a 50-character app version',
      ).toBe(200);
      expect((await phone.removeDevice(device('bad'))).status()).toBe(200);
    });

    test('PUSH-02 a new Job offer is one visible job-offer push per phone, in English and in Spanish, naming the Host, Job number, date and places', async () => {
      expect(deviceRow(enToken), 'PUSH-01 registered the phones').toMatch(/^1\|/);
      await settlePushes();
      const mark = stub.mark();
      offer.date = hostToday(2);
      const created = await assignments.create(assignment({ assignmentDate: offer.date, notes: `${MARKER} offer` }));
      expect(created.status, created.text).toBe(201);
      offer.id = Number(created.data);
      offer.uuid = assignmentUuid(offer.id);
      await expect.poll(() => driversRow(offer.uuid, 'Status'), { message: 'JobOffered reaches DRIVERS', ...QUEUE }).toBe('1');

      const pushes = await onePushEach(mark, [enToken, esToken]);
      const [job, origin, destination] = (driversRow(offer.uuid, 'JobDocNameWithPrefix, Origin, Destination') ?? '').split('|');
      const data = { type: 'job-offer', hostUuid, orderAssignmentUuid: offer.uuid };
      expect(pushes[enToken]).toEqual({
        to: enToken,
        title: `New Job from ${hostName}`,
        body: env.pushShowContent ? `${job} on ${pushDate(offer.date, 'en')}: ${placeName(origin)} to ${placeName(destination)}` : OPEN_APP.en,
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
      expect(pushes[esToken]).toEqual({
        to: esToken,
        title: `Nuevo trabajo de ${hostName}`,
        body: env.pushShowContent ? `${job} el ${pushDate(offer.date, 'es')}: ${placeName(origin)} a ${placeName(destination)}` : OPEN_APP.es,
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
    });

    test('PUSH-03 a dispatch message is one visible message push per phone with the text (whitespace collapsed, cut to 150 characters) and its message and assignment UUIDs', async () => {
      expect(offer.id, 'PUSH-02 created the assignment').toBeGreaterThan(0);
      await settlePushes();
      const mark = stub.mark();
      const text = `${MARKER} message ${run}\n\n  Load 2 is ready at the scale house,   please come to door 3 when you arrive. Bring your ticket book and your safety vest, and call dispatch if the gate is closed.`;
      const sent = await host.sendDispatchMessage(driverId, offer.id, text);
      expect(sent.status(), await sent.text()).toBe(200);
      const messageUuid = (
        hostValue(`SELECT LOWER(CONVERT(nvarchar(36), MessageUUID)) FROM app.Messages WHERE MessageBody = ${sqlText(text)}`) ?? ''
      ).toLowerCase();
      expect(messageUuid, 'the host stored the message').toMatch(/^[0-9a-f-]{36}$/);
      await expect
        .poll(() => driversNumber(`SELECT COUNT(*) FROM app.Messages WHERE MessageUUID = '${messageUuid}'`), {
          message: 'MessageSent reaches DRIVERS',
          ...QUEUE,
        })
        .toBe(1);
      const threadUuid = (
        driversValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.Messages WHERE MessageUUID = '${messageUuid}'`) ?? ''
      ).toLowerCase();

      const pushes = await onePushEach(mark, [enToken, esToken]);
      const body = pushBody(text);
      expect(body.length, 'the expected body is cut').toBe(150);
      const data = { type: 'message', hostUuid, messageUuid, orderAssignmentUuid: threadUuid };
      expect(pushes[enToken]).toEqual({
        to: enToken,
        title: `Message from ${hostName}`,
        body: env.pushShowContent ? body : OPEN_APP.en,
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
      expect(pushes[esToken]).toEqual({
        to: esToken,
        title: `Mensaje de ${hostName}`,
        body: env.pushShowContent ? body : OPEN_APP.es,
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
    });

    test('PUSH-04 two messages and a Job offer inside one coalescing window are one summary push per phone with the counts', async () => {
      expect(offer.id, 'PUSH-02 created the assignment').toBeGreaterThan(0);
      await settlePushes();
      const mark = stub.mark();
      const first = await host.sendDispatchMessage(driverId, offer.id, `${MARKER} burst one ${run}`);
      const second = await host.sendDispatchMessage(driverId, offer.id, `${MARKER} burst two ${run}`);
      const created = await assignments.create(assignment({ orderId: SECOND_ORDER_ID, assignmentDate: hostToday(3), notes: `${MARKER} burst offer` }));
      expect([first.status(), second.status(), created.status], created.text).toEqual([200, 200, 201]);
      const burstUuid = assignmentUuid(Number(created.data));
      const threads = driversValue(
        `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)), ',') FROM app.Messages WHERE MessageBody LIKE N'${MARKER} burst % ${run}'`,
      );
      test
        .info()
        .annotations.push({ type: 'burst-offer', description: burstUuid }, { type: 'message-threads-at-send', description: threads ?? 'not yet in DRIVERS' });

      const pushes = await onePushEach(mark, [enToken, esToken]);
      const data = { type: 'summary', jobOffers: 1, messages: 2, hostUuid };
      expect(pushes[enToken]).toEqual({
        to: enToken,
        title: hostName,
        body: '1 Job offer and 2 messages',
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
      expect(pushes[esToken]).toEqual({
        to: esToken,
        title: hostName,
        body: '1 oferta de trabajo y 2 mensajes',
        sound: 'default',
        data,
        _contentAvailable: true,
        priority: 'high',
      });
    });

    test('PUSH-05 a time-window change alone is one silent sync push per phone, with no title, body or sound', async () => {
      expect(offer.id, 'PUSH-02 created the assignment').toBeGreaterThan(0);
      await settlePushes();
      const mark = stub.mark();
      const changed = await host.setTimeWindow(offer.id, '08:30', '15:00');
      expect(changed.status(), await changed.text()).toBe(200);
      await expect
        .poll(() => driversRow(offer.uuid, 'CONVERT(varchar(5), TimeWindowStart, 108), CONVERT(varchar(5), TimeWindowEnd, 108)'), {
          message: 'JobChanged reaches DRIVERS',
          ...QUEUE,
        })
        .toBe('08:30|15:00');

      const pushes = await onePushEach(mark, [enToken, esToken]);
      for (const token of [enToken, esToken]) {
        expect(pushes[token]).toEqual({ to: token, data: { type: 'sync' }, _contentAvailable: true, priority: 'high' });
      }
    });

    test('PUSH-06 Expo answering DeviceNotRegistered turns the token off with PushDisabledAt, and registering it again turns it back on and clears PushDisabledAt', async () => {
      expect(offer.id, 'PUSH-02 created the assignment').toBeGreaterThan(0);
      const registered = await phone.registerDevice({
        token: goneToken,
        platform: 'android',
        deviceId: device('gone'),
        language: 'en',
        appVersion: '1.4.0-e2e',
      });
      expect(registered.status(), await registered.text()).toBe(200);
      expect(deviceRow(goneToken)).toMatch(/^1\|en\|1\.4\.0-e2e\|on\|/);
      await settlePushes();
      const mark = stub.mark();

      const changed = await host.setTimeWindow(offer.id, '09:00', '14:00');
      expect(changed.status(), await changed.text()).toBe(200);
      await expect.poll(() => stub.messagesTo(mark, goneToken).length, { message: 'the Drivers API pushes to the Gone token', ...QUEUE }).toBeGreaterThan(0);
      await expect
        .poll(() => deviceRow(goneToken), { message: 'Expo said DeviceNotRegistered, so the token is turned off', ...QUEUE })
        .toBe('0|en|1.4.0-e2e|disabled|drivers-push');
      expect(deviceRow(enToken), 'the other phones stay on').toMatch(/^1\|en\|.*\|on\|/);

      const again = await phone.registerDevice({ token: goneToken, platform: 'android', deviceId: device('gone'), language: 'es' });
      expect(again.status(), await again.text()).toBe(200);
      expect((await again.json()).data).toMatchObject({ language: 'es' });
      expect(deviceRow(goneToken), 're-registering turns it on and clears PushDisabledAt').toMatch(/^1\|es\|-\|on\|/);
      expect((await phone.removeDevice(device('gone'))).status()).toBe(200);
    });
  },
);
