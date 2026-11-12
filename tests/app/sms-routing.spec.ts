// QC-930 (D96, D105, D110): texts for linked Drivers come from the Drivers API, and the Assign Truck "Send Message Via SMS" tick is
// retired. A host user is linked when auth.Users.UserUUID is set: the Host never texts them; the offer or message is stored as
// App (Channel 20) and rides to DRIVERS (inside JobOffered for an offer), where the Driver's own DriverSettings.NotifyBySms decides
// whether the Drivers API texts it from the Host's number. An unlinked driver is texted (Channel 10) only with a phone and
// app.UserSettings.NotifyBySms on. Every save that makes an offer sends it; other edits send nothing.
// Local only, against the QC-930 host API, Drivers API and copies of their databases. Throwaway data: seed/host-qc930.apply.sql
// (vendor, three trucks, the drivers linked / plain / quiet, an order open for a week and one seeded edit row),
// seed/drivers-qc930.apply.sql (the linked Driver's DRIVERS account, DriverSettings and host link) and
// seed/identity-qc930-user.apply.sql (its Identity login, for the Drivers API token of SMSRT-05). The matching *.remove.sql run
// before and after. HOST_API_LOG / DRIVERS_API_LOG (optional) let the cases read the logging SMS senders' lines.
import { randomUUID } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseIdentityDb,
  queryDriversDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';
import { MESSAGE_CHANNEL } from '@pages/comms-send-gate.page';
import { SmsRoutingApi } from '@api/sms-routing.api';
import { DispatchContactSession } from '@pages/dispatch-contact.page';
import {
  COMMS_REFUSAL,
  COPY_HINT,
  HOST_SMS_LOGGED,
  OFFER_DELIVERY,
  OFFER_HISTORY,
  SMS_ROUTING_MARKER,
  assignmentUuidOf,
  driversAssignmentExists,
  driversLog,
  driversMessageExists,
  driversMessagesOn,
  driversPhoneOf,
  driversTextSettingOf,
  escapeRegex,
  historyOf,
  hostLog,
  hostMessagingUuid,
  hostPhoneOf,
  hostTwilioFromNumber,
  hostUserId,
  hostUserSettingOf,
  messagesOfDriver,
  offerMessagesOf,
  parseRoutingSeed,
  setDriversPhone,
  setHostLanguageAndPush,
  setDriversTextSetting,
  type SeededRouting,
} from '@pages/sms-routing.page';

const VENDOR = 'E2E QC-930 Vendor';
const LINKED_EMAIL = 'e2e.qc930.linked@quarryconnect.test';
const PHONE = { linked: '5125559301', plain: '5125559302', quiet: '5125559303' } as const;
const ORG_CACHE = { timeout: 180_000, intervals: [5_000] };
const QUEUE = { timeout: 30_000, intervals: [500, 1_000, 2_000] };

function hostDay(offset = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function queuesDrained(): boolean {
  return (
    querySingleValue(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === '0' &&
    queryDriversDb(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === '0' &&
    queryDriversDb(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === '0'
  );
}

function removeAll(linkedUuid: string): void {
  const host = runSeedScript('host-qc930.remove.sql');
  const drivers = runDriversSeedScript('drivers-qc930.remove.sql', { UserId: linkedUuid });
  const identity = runIdentitySeedScript('identity-qc930.remove.sql');
  for (const [where, output] of [
    ['host', host],
    ['DRIVERS', drivers],
    ['Identity', identity],
  ]) {
    if (!/REMOVED left=0/.test(output)) throw new Error(`QC-930 ${where} rows are left behind:\n${output}`);
  }
}

async function signedIn(api: SmsRoutingApi): Promise<SmsRoutingApi> {
  await api.signIn(env.appAdmin!.email, env.appAdmin!.password);
  return api;
}

test.describe('Texts for linked Drivers come from the Drivers API; the Send SMS tick is retired (QC-930)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the local host, DRIVERS and Identity databases.');
  test.skip(
    !env.appAdmin || !env.appApiUrl || !env.appUrl || !env.driversApiUrl || !env.admin,
    'Needs APP_ADMIN_*, ADMIN_*, APP_URL, APP_API_URL and DRIVERS_API_URL.',
  );
  test.skip(
    canUseDriversDb() && queryDriversDb(`SELECT CASE WHEN COL_LENGTH(N'app.DriverSettings', N'NotifyBySms') IS NULL THEN 0 ELSE 1 END`) !== '1',
    'The QC-930 DRIVERS migration (app.DriverSettings.NotifyBySms) is not applied.',
  );

  const linkedUuid = randomUUID();
  let seeded: SeededRouting;
  let hostUuid: string;
  let fromNumber: string;
  const ids = { linked: '', plain: '', quiet: '' };
  const offers: { linkedDay1: number; plainDay1: number } = { linkedDay1: 0, plainDay1: 0 };
  let inAppMessageId = 0;
  let plainOfferMessageId = 0;
  let session: DispatchContactSession;
  let driverToken = '';

  test.beforeAll(async ({ playwright, browser }) => {
    test.setTimeout(300_000);
    removeAll(linkedUuid);
    hostUuid = hostMessagingUuid();
    seeded = parseRoutingSeed(runSeedScript('host-qc930.apply.sql', { LinkedId: linkedUuid }));
    runDriversSeedScript('drivers-qc930.apply.sql', { UserId: linkedUuid, HostUuid: hostUuid });
    runIdentitySeedScript('identity-qc930-user.apply.sql', { UserId: linkedUuid, SourceEmail: env.admin!.email });
    ids.linked = hostUserId('linked');
    ids.plain = hostUserId('plain');
    ids.quiet = hostUserId('quiet');
    fromNumber = hostTwilioFromNumber();

    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const api = await signedIn(new SmsRoutingApi(context));
      await expect
        .poll(async () => ((await api.assignVendor(seeded.vendor)) as { trucks?: unknown[] } | null)?.trucks?.length ?? 0, {
          message: 'the host API sees the new vendor and its trucks once its organisation tree cache (Auth:OrganisationTreeCacheSeconds) expires',
          ...ORG_CACHE,
        })
        .toBe(3);
    } finally {
      await context.dispose();
    }
    session = await DispatchContactSession.signIn(browser, env.appAdmin!);
  });

  test.afterAll(async () => {
    await session?.close();
    for (let wait = 0; wait < 40 && !queuesDrained(); wait++) await new Promise((resolve) => setTimeout(resolve, 500));
    removeAll(linkedUuid);
  });

  test('SMSRT-01 Assign Truck has no "Send Message Via SMS" tick: a new assignment shows the Offer Message box with the delivery line per driver, and an edit that keeps the driver shows no box', async () => {
    const dialog = session.schedule;
    await dialog.openDialog();
    await dialog.chooseOrder(seeded.order);
    await dialog.chooseVendor(VENDOR);
    await dialog.chooseTruck(/E2E QC-930 Plain$/);
    await dialog.expectOfferBox(OFFER_DELIVERY.textedTo(PHONE.plain));
    await expect(dialog.offerDelivery).toHaveClass(/alert-info/);
    await dialog.chooseTruck(/E2E QC-930 Linked$/);
    await dialog.expectOfferBox(OFFER_DELIVERY.app);
    await dialog.chooseTruck(/E2E QC-930 Quiet$/);
    await dialog.expectOfferBox(OFFER_DELIVERY.textsOff);
    await expect(dialog.offerDelivery).toHaveClass(/alert-warning/);
    await dialog.cancel.click();
    await expect(dialog.dialog).toHaveCount(0);

    await dialog.openSchedule(hostDay());
    await dialog.openBar('QC-930 Plain');
    await dialog.expectNoOfferBox();
    await dialog.cancel.click();
    expect(messagesOfDriver(ids.plain), 'opening the dialogs sent nothing').toBe(0);
  });

  test('SMSRT-02 an offer to a linked driver is stored as App (Channel 20, no Twilio sid, with a reply link), rides inside JobOffered to DRIVERS with one message, and the Drivers API texts it only when DriverSettings.NotifyBySms is 1 or NULL', async ({
    smsRoutingApi,
  }) => {
    const api = await signedIn(smsRoutingApi);
    const preview = await api.driverSmsPreview(seeded.order, seeded.vendor, ids.linked);
    expect(preview.status, preview.text).toBe(200);
    expect(preview.data).toMatchObject({ delivery: 'app', canSend: true, cannotSendReason: null });

    const original = driversTextSettingOf(linkedUuid).notifyBySms;
    try {
      for (const [offset, setting] of [
        [1, 1],
        [2, null],
        [3, 0],
      ] as const) {
        setDriversTextSetting(linkedUuid, setting);
        const mark = driversLog.mark();
        const saved = await api.saveDriverAssignment({
          orderId: seeded.order,
          assignmentDate: hostDay(offset),
          vendorId: seeded.vendor,
          truckId: seeded.truckL,
          driverUserId: ids.linked,
          notes: `${SMS_ROUTING_MARKER} linked ${setting}`,
        });
        expect(saved.status, saved.text).toBe(201);
        const assignment = Number(saved.data);
        if (offset === 1) offers.linkedDay1 = assignment;

        const [message, ...more] = offerMessagesOf(assignment);
        expect(more, 'one offer message on the host').toHaveLength(0);
        expect(message).toMatchObject({ channel: MESSAGE_CHANNEL.InApp, sid: null, replyLinks: 1 });
        expect(message.sentAt).not.toBeNull();
        expect(historyOf(assignment)).toContain(OFFER_HISTORY.app);

        const uuid = assignmentUuidOf(assignment);
        await expect.poll(() => driversAssignmentExists(uuid), { message: `JobOffered ${uuid} reaches DRIVERS`, ...QUEUE }).toBe(true);
        await expect.poll(() => driversMessagesOn(uuid).length, { message: 'the offer message rides in JobOffered', ...QUEUE }).toBe(1);
        expect(driversMessagesOn(uuid)[0]).toEqual({ messageUuid: message.uuid, messageType: 10, body: message.body });

        if (driversLog.available) {
          const user = escapeRegex(linkedUuid);
          if (setting !== 1) {
            await driversLog.expectLine(
              mark,
              new RegExp(`No text for driver ${user}: their Text messages setting is not on\\.`, 'i'),
              'the Drivers API skips the text',
            );
            expect(driversLog.since(mark)).not.toMatch(new RegExp(`Texting driver ${user}`, 'i'));
          } else {
            await driversLog.expectLine(
              mark,
              new RegExp(`Texting driver ${user} from host ${escapeRegex(hostUuid)}'s number ${escapeRegex(fromNumber)}\\.`, 'i'),
              `the Drivers API texts the offer (NotifyBySms ${setting})`,
            );
            expect(driversLog.since(mark)).toContain(`Twilio is not configured; SMS from ${fromNumber} to ***${PHONE.linked.slice(-4)} logged instead of sent`);
          }
          expect(driversMessagesOn(uuid), 'no separate MessageSent duplicate arrives').toHaveLength(1);
        }
      }
    } finally {
      setDriversTextSetting(linkedUuid, original === null ? null : (original as 0 | 1));
    }
    expect(driversTextSettingOf(linkedUuid).notifyBySms).toBe(original);
  });

  test('SMSRT-03 an unlinked driver is texted (Channel 10) only with a phone and Text messages on; with them off nothing is sent and the history says why; an edit that keeps the driver sends nothing', async ({
    smsRoutingApi,
  }) => {
    const api = await signedIn(smsRoutingApi);
    expect((await api.driverSmsPreview(seeded.order, seeded.vendor, ids.plain)).data).toMatchObject({
      delivery: 'sms',
      canSend: true,
      phoneNumber: PHONE.plain,
    });
    expect((await api.driverSmsPreview(seeded.order, seeded.vendor, ids.quiet)).data).toMatchObject({
      delivery: 'none',
      canSend: false,
      cannotSendReason: 'Text messages are off for them.',
    });

    const mark = hostLog.mark();
    const plain = {
      orderId: seeded.order,
      assignmentDate: hostDay(1),
      vendorId: seeded.vendor,
      truckId: seeded.truckP,
      driverUserId: ids.plain,
      notes: `${SMS_ROUTING_MARKER} plain`,
    };
    const saved = await api.saveDriverAssignment(plain);
    expect(saved.status, saved.text).toBe(201);
    offers.plainDay1 = Number(saved.data);
    const [message, ...more] = offerMessagesOf(offers.plainDay1);
    expect(more).toHaveLength(0);
    expect(message).toMatchObject({ channel: MESSAGE_CHANNEL.Sms, replyLinks: 1 });
    expect(message.sid, 'the logging SMS sender stamps a STUB id').toMatch(/^STUB/);
    plainOfferMessageId = message.id;
    expect(historyOf(offers.plainDay1)).toContain(OFFER_HISTORY.sms);
    if (hostLog.available) await hostLog.expectLine(mark, new RegExp(escapeRegex(HOST_SMS_LOGGED)), 'the host logs the SMS instead of sending it');

    const edited = await api.updateDriverAssignment(offers.plainDay1, { ...plain, notes: `${SMS_ROUTING_MARKER} plain edited` });
    expect(edited.status, edited.text).toBe(200);
    expect(offerMessagesOf(offers.plainDay1), 'an edit that keeps the driver sends no offer').toHaveLength(1);
    expect(historyOf(offers.plainDay1).filter((h) => h === OFFER_HISTORY.sms)).toHaveLength(1);

    const quiet = await api.saveDriverAssignment({ ...plain, truckId: seeded.truckQ, driverUserId: ids.quiet, notes: `${SMS_ROUTING_MARKER} quiet` });
    expect(quiet.status, quiet.text).toBe(201);
    expect(offerMessagesOf(Number(quiet.data)), 'no message row for a driver with Text messages off').toHaveLength(0);
    expect(messagesOfDriver(ids.quiet)).toBe(0);
    expect(historyOf(Number(quiet.data))).toContain(OFFER_HISTORY.textsOff);
  });

  test('SMSRT-04 Messages page: an SMS to an unlinked driver with Text messages off is refused; an SMS to a linked driver is stored as App and reaches DRIVERS', async ({
    smsRoutingApi,
  }) => {
    const api = await signedIn(smsRoutingApi);
    expect((await api.commsThread(ids.quiet)).data).toMatchObject({ canSendSms: false });
    expect((await api.commsThread(ids.plain)).data).toMatchObject({ canSendSms: true });
    expect((await api.commsThread(ids.linked)).data).toMatchObject({ canSendSms: false, canSendInApp: true });

    const refused = await api.commsSend(ids.quiet, `E2E-QC930 quiet ${Date.now()}`, 'sms');
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toContain(COMMS_REFUSAL.textsOff);
    expect(messagesOfDriver(ids.quiet)).toBe(0);

    const sent = await api.commsSend(ids.linked, `E2E-QC930 linked ${Date.now()}`, 'sms');
    expect(sent.status, sent.text).toBe(200);
    inAppMessageId = Number(sent.data?.messageId);
    expect(inAppMessageId).toBeGreaterThan(0);
    const row = querySingleValue(
      `SELECT CONCAT(Channel, '|', ISNULL(TwilioMessageSid, '~'), '|', LOWER(CONVERT(nvarchar(36), MessageUUID))) FROM app.Messages WHERE MessageID = ${inAppMessageId}`,
    )!.split('|');
    expect(row.slice(0, 2)).toEqual([String(MESSAGE_CHANNEL.InApp), '~']);
    await expect.poll(() => driversMessageExists(row[2]), { message: 'MessageSent reaches DRIVERS', ...QUEUE }).toBe(true);
  });

  test('SMSRT-05 PUT me/settings { NotifyBySms: false } sets DRIVERS NotifyBySms 0 and raises ContactVersion; DriverContactChanged turns the host Text messages off without wiping the host phone', async ({
    passwordGrantApi,
    driverSettingsApi,
  }) => {
    const token = await passwordGrantApi.passwordGrant(LINKED_EMAIL, env.admin!.password);
    expect(token.status, JSON.stringify(token.body)).toBe(200);
    const accessToken = token.body.access_token!;
    driverToken = accessToken;
    const before = driversTextSettingOf(linkedUuid);
    const hostBefore = hostUserSettingOf(ids.linked);
    const hostPhone = hostPhoneOf(ids.linked);
    const driversPhone = driversPhoneOf(linkedUuid);
    expect(hostBefore).toMatchObject({ exists: true, notifyBySms: 1, mobilePhone: PHONE.linked });

    setDriversPhone(linkedUuid, null);
    try {
      const read = await driverSettingsApi.settings(accessToken);
      expect(read.status, JSON.stringify(read.body)).toBe(200);
      expect(read.body.data).toMatchObject({ NotifyBySms: true });

      const off = await driverSettingsApi.saveSettings(accessToken, { NotifyBySms: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      expect(off.body.data).toMatchObject({ NotifyBySms: false });
      const turnedOff = driversTextSettingOf(linkedUuid);
      expect(turnedOff).toEqual({ notifyBySms: 0, contactVersion: (before.contactVersion ?? 0) + 1 });

      await expect.poll(() => hostUserSettingOf(ids.linked).notifyBySms, { message: 'DriverContactChanged reaches the host', ...QUEUE }).toBe(0);
      const hostAfter = hostUserSettingOf(ids.linked);
      expect(hostAfter.contactVersion).toBe(turnedOff.contactVersion);
      expect(hostAfter.mobilePhone, 'a blank MobilePhone keeps the host setting phone').toBe(PHONE.linked);
      expect(hostPhoneOf(ids.linked), 'a blank MobilePhone keeps the host user phone').toBe(hostPhone);
    } finally {
      const on = await driverSettingsApi.saveSettings(accessToken, { NotifyBySms: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
      setDriversPhone(linkedUuid, driversPhone);
    }
    expect(driversTextSettingOf(linkedUuid).notifyBySms).toBe(1);
    expect(driversPhoneOf(linkedUuid)).toBe(driversPhone);
    await expect.poll(() => hostUserSettingOf(ids.linked).notifyBySms, { message: 'turning it back on reaches the host', ...QUEUE }).toBe(1);
  });

  test('SMSRT-06 the Messages page channel badge reads "App" for an in-app message and "SMS" for a texted one, with the new tooltips', async () => {
    const commsPage = session.comms;
    expect(inAppMessageId, 'SMSRT-04 stored an in-app message').toBeGreaterThan(0);
    await commsPage.open(ids.linked);
    await expect(commsPage.channelBadge(inAppMessageId)).toHaveText(/^\s*\S*\s*App\s*$/);
    await commsPage.channelBadge(inAppMessageId).hover();
    await expect(commsPage.tooltip()).toHaveText("Sent to the Driver App. The Driver's own Text messages setting decides whether it was also texted.");

    expect(plainOfferMessageId, 'SMSRT-03 texted an offer').toBeGreaterThan(0);
    await commsPage.open(ids.plain);
    await expect(commsPage.channelBadge(plainOfferMessageId)).toContainText('SMS');
    await commsPage.channelBadge(plainOfferMessageId).hover();
    await expect(commsPage.tooltip()).toHaveText("Texted from this Host's number.");
  });

  test('SMSRT-07 Copy with "Notify drivers now" follows the same rule per copy: the linked copy goes to the Driver App inside JobOffered, the unlinked copy is texted; the dialog hint counts offers', async ({
    smsRoutingApi,
  }) => {
    const copy = session.copySchedule;
    expect(offers.linkedDay1 * offers.plainDay1, 'SMSRT-02 and SMSRT-03 made the source offers').toBeGreaterThan(0);
    expect(driversTextSettingOf(linkedUuid).notifyBySms).toBe(1);

    await copy.open(hostDay(1));
    await copy.notifyDrivers.check();
    await expect(copy.offerHint()).toHaveText(COPY_HINT);
    await expect(copy.retiredHint()).toHaveCount(0);
    await copy.close.click();
    await expect(copy.dialog).toHaveCount(0);

    const api = await signedIn(smsRoutingApi);
    const mark = driversLog.mark();
    const copied = await api.copyAndNotify(hostDay(1), [offers.linkedDay1, offers.plainDay1], [hostDay(4)]);
    expect(copied.status, copied.text).toBe(200);

    const copyOf = (driverUserId: string) =>
      Number(
        querySingleValue(`SELECT OrderAssignmentID FROM app.OrderAssignments WHERE OrderID_FK = ${seeded.order} AND DriverUserID_FK = N'${driverUserId}'
          AND AssignmentDate = '${hostDay(4)}'`),
      );
    const linkedCopy = copyOf(ids.linked);
    const plainCopy = copyOf(ids.plain);
    expect(linkedCopy * plainCopy, 'both rows were copied').toBeGreaterThan(0);

    const [linkedMessage, ...moreLinked] = offerMessagesOf(linkedCopy);
    expect(moreLinked).toHaveLength(0);
    expect(linkedMessage).toMatchObject({ channel: MESSAGE_CHANNEL.InApp, sid: null, replyLinks: 1 });
    expect(historyOf(linkedCopy)).toContain(OFFER_HISTORY.app);
    const uuid = assignmentUuidOf(linkedCopy);
    await expect.poll(() => driversMessagesOn(uuid).length, { message: 'the copied offer reaches DRIVERS with its message', ...QUEUE }).toBe(1);
    expect(driversMessagesOn(uuid)[0].messageUuid).toBe(linkedMessage.uuid);
    if (driversLog.available) {
      await driversLog.expectLine(mark, new RegExp(`Texting driver ${escapeRegex(linkedUuid)} from host`, 'i'), 'the Drivers API texts the copied offer');
    }

    const [plainMessage, ...morePlain] = offerMessagesOf(plainCopy);
    expect(morePlain).toHaveLength(0);
    expect(plainMessage).toMatchObject({ channel: MESSAGE_CHANNEL.Sms, replyLinks: 1 });
    expect(plainMessage.sid).toMatch(/^STUB/);
    expect(historyOf(plainCopy)).toContain(OFFER_HISTORY.sms);
  });

  test("SMSRT-08 a Text messages change made in the Driver App keeps the host's LanguageCode (DRIVERS sends none) and reports push on (the Driver App has no push opt-out)", async ({
    driverSettingsApi,
  }) => {
    expect(driverToken, 'SMSRT-05 got a Drivers API token').not.toBe('');
    setHostLanguageAndPush(ids.linked, 'es', 0);
    try {
      const off = await driverSettingsApi.saveSettings(driverToken, { NotifyBySms: false });
      expect(off.status, JSON.stringify(off.body)).toBe(200);
      await expect.poll(() => hostUserSettingOf(ids.linked).notifyBySms, { message: 'DriverContactChanged reaches the host', ...QUEUE }).toBe(0);
      expect(hostUserSettingOf(ids.linked)).toMatchObject({ languageCode: 'es', notifyByPush: 1 });
    } finally {
      const on = await driverSettingsApi.saveSettings(driverToken, { NotifyBySms: true });
      expect(on.status, JSON.stringify(on.body)).toBe(200);
    }
    expect(driversTextSettingOf(linkedUuid).notifyBySms).toBe(1);
    await expect.poll(() => hostUserSettingOf(ids.linked).notifyBySms, { message: 'turning it back on reaches the host', ...QUEUE }).toBe(1);
  });
});
