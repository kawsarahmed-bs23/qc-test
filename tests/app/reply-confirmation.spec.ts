import { randomUUID } from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb, queryDriversDb } from '@utils/localDb';
import { PasswordGrantApi } from '@api/password-grant.api';
import { DriverSyncApi } from '@api/driver-sync.api';
import { DriversMirrorApi } from '@api/drivers-mirror.api';
import { DriverAppReplyApi, HostReplyConfirmation, type ReplyConfirmationSetting } from '@api/reply-confirmation.api';
import { HostDriversMode } from '@api/sms-routing.api';
import { MESSAGE_CHANNEL } from '@pages/comms-send-gate.page';
import { ReplyLinkApi, smsStaysLocal } from '@pages/reply-links.page';
import { ASSIGNMENT_STATUS } from '@pages/message-link.page';
import { driversLog } from '@pages/sms-routing.page';
import {
  DRIVERS_SMS_FROM,
  LINKED_EMAIL,
  LINKED_PHONE,
  PLAIN_PHONE,
  SYSTEM_MESSAGE_TYPE,
  confirmationRowsOf,
  confirmationText,
  driversAnswerCode,
  driversAssignmentStatus,
  driversHostRow,
  driversHostUuid,
  hostAssignmentStatus,
  hostMessageWatermark,
  loggedTextsFrom,
  outboundSystemTextsToPhone,
  removeConfirmationRows,
  seedConfirmationRows,
  seedLinkedDriversRows,
  setDriversHostRow,
  type ConfirmationSeed,
  type DriversHostRow,
  type Slot,
} from '@pages/reply-confirmation.page';

const DRIVERS_PENDING = 1;
const DRIVERS_ACCEPTED = 2;
const DRIVERS_REJECTED = 3;
const HOST_PENDING = ASSIGNMENT_STATUS.Pending;

test.describe('Reply confirmation text after a button answer (QC-937, D88)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(
    env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(),
    'Needs the local host, DRIVERS and Identity databases to seed drivers and read the stored texts.',
  );
  test.skip(!env.appApiUrl || !env.driversApiUrl || !env.admin, 'Needs APP_API_URL, DRIVERS_API_URL and ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway driver copies that password).');
  test.skip(!driversLog.available, 'Needs DRIVERS_API_LOG: the Drivers API logs the text it would send, because Twilio is blank locally.');
  test.skip(canSeedLocalDb() && !smsStaysLocal(), 'Twilio FromPhoneNumber is set and Twilio:ApiBaseAddress is not a local stub, so an SMS would really go out.');

  let seed: ConfirmationSeed;
  let s: Record<string, Slot>;
  let hostUuid: string;
  let watermark: number;
  let originalHostRow: DriversHostRow;
  let originalSetting: ReplyConfirmationSetting | null;
  let hostRequest: APIRequestContext;
  let links: ReplyLinkApi;
  let sync: DriverSyncApi;
  let mirror: DriversMirrorApi;
  let appReply: DriverAppReplyApi;
  let linkedModeOn = false;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(180_000);
    hostUuid = driversHostUuid();
    originalHostRow = driversHostRow(hostUuid);
    watermark = hostMessageWatermark();
    hostRequest = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    originalSetting = new HostReplyConfirmation(hostRequest).current();
    linkedModeOn = new HostDriversMode(hostRequest).current() === 'On';

    seed = seedConfirmationRows([
      { slot: 'accept', who: 'plain' },
      { slot: 'decline', who: 'plain' },
      { slot: 'twice', who: 'plain' },
      { slot: 'comment', who: 'plain' },
      { slot: 'off', who: 'plain' },
      { slot: 'webacc', who: 'linked' },
      { slot: 'appacc', who: 'linked' },
      { slot: 'appdec', who: 'linked' },
      { slot: 'appbtn', who: 'linked' },
      { slot: 'appq', who: 'linked' },
      { slot: 'appoff', who: 'linked' },
    ]);
    s = seed.slots;
    seedLinkedDriversRows(seed, hostUuid, env.admin!.email);
    setDriversHostRow(hostUuid, { smsFromNumber: DRIVERS_SMS_FROM, replyConfirmation: 1 });

    const token = await new PasswordGrantApi(hostRequest).passwordGrant(LINKED_EMAIL, env.admin!.password);
    expect(token.status, `password grant: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
    const appRequest = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    sync = new DriverSyncApi(appRequest, token.body.access_token!);
    mirror = new DriversMirrorApi(appRequest, token.body.access_token!);
    appReply = new DriverAppReplyApi(appRequest, token.body.access_token!);
  });

  test.beforeEach(async () => {
    links = await ReplyLinkApi.open();
  });

  test.afterEach(async () => {
    await links?.close();
  });

  test.afterAll(async () => {
    try {
      if (hostRequest && originalSetting && new HostReplyConfirmation(hostRequest).current() !== originalSetting) {
        await new HostReplyConfirmation(hostRequest).set(originalSetting);
      }
    } finally {
      try {
        if (originalHostRow) setDriversHostRow(hostUuid, originalHostRow);
      } finally {
        if (seed) removeConfirmationRows(seed.linkedId);
        await hostRequest?.dispose();
      }
    }
  });

  test('REPCONF-01 Accept on the web reply page of a driver the host texts itself stores exactly one outbound System text, "<job>: you replied Accept. Thanks.", as a reply to the offer', async () => {
    expect(confirmationRowsOf(s.accept.messageId)).toHaveLength(0);

    const answer = await links.reply(s.accept.code, { option: 'accept' });
    expect(answer.status, answer.text).toBe(200);

    const rows = confirmationRowsOf(s.accept.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 20,
      messageType: SYSTEM_MESSAGE_TYPE,
      channel: MESSAGE_CHANNEL.Sms,
      replyTo: s.accept.messageId,
      phone: PLAIN_PHONE,
    });
    expect(rows[0].body).toContain(confirmationText(seed.jobDoc, 'Accept'));
    expect(rows[0].body).toContain('you replied Accept. Thanks.');
  });

  test('REPCONF-02 Decline stores one text "<job>: you replied Decline. Thanks."', async () => {
    const answer = await links.reply(s.decline.code, { option: 'cant' });
    expect(answer.status, answer.text).toBe(200);

    const rows = confirmationRowsOf(s.decline.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ direction: 20, messageType: SYSTEM_MESSAGE_TYPE, channel: MESSAGE_CHANNEL.Sms, replyTo: s.decline.messageId });
    expect(rows[0].body).toContain(confirmationText(seed.jobDoc, 'Decline'));
    expect(rows[0].body).toContain('you replied Decline. Thanks.');
  });

  test('REPCONF-03 a second answer to the same link is refused with 400 and no second text is sent', async () => {
    const first = await links.reply(s.twice.code, { option: 'accept' });
    expect(first.status, first.text).toBe(200);
    expect(confirmationRowsOf(s.twice.messageId)).toHaveLength(1);

    const second = await links.replyOnce(s.twice.code, { option: 'cant' });
    expect(second.status, second.text).toBe(400);
    const third = await links.replyOnce(s.twice.code, { option: 'accept' });
    expect(third.status, third.text).toBe(400);

    const rows = confirmationRowsOf(s.twice.messageId);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toContain('you replied Accept. Thanks.');
  });

  test('REPCONF-04 a comment (option question) sends no confirmation text', async () => {
    const answer = await links.reply(s.comment.code, { option: 'question', comment: 'E2E-QC937-RC a question for dispatch' });
    expect(answer.status, answer.text).toBe(200);

    expect(confirmationRowsOf(s.comment.messageId)).toHaveLength(0);
    expect(outboundSystemTextsToPhone(PLAIN_PHONE, watermark), 'only the confirmations of REPCONF-01 to 03 exist for this phone').toBe(3);
  });

  test('REPCONF-05 a driver linked to the Drivers API gets no text from the host after a web answer: the Drivers API sends exactly one, once', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    const mark = driversLog.mark();

    const answer = await links.reply(s.webacc.code, { option: 'accept' });
    expect(answer.status, answer.text).toBe(200);

    await expect
      .poll(() => loggedTextsFrom(mark, DRIVERS_SMS_FROM), { message: 'the Drivers API logs the confirmation it would text', timeout: 30_000 })
      .toHaveLength(1);
    expect(loggedTextsFrom(mark, DRIVERS_SMS_FROM)).toEqual([confirmationText(seed.jobDoc, 'Accept').length]);
    expect(confirmationRowsOf(s.webacc.messageId)).toHaveLength(0);
    expect(outboundSystemTextsToPhone(LINKED_PHONE, watermark)).toBe(0);
    await expect.poll(() => driversAnswerCode(s.webacc.messageUuid), { timeout: 30_000 }).toBe('accept');

    const again = await links.replyOnce(s.webacc.code, { option: 'cant' });
    expect(again.status, again.text).toBe(400);
    expect(loggedTextsFrom(mark, DRIVERS_SMS_FROM)).toHaveLength(1);
    expect(confirmationRowsOf(s.webacc.messageId)).toHaveLength(0);
  });

  test('REPCONF-06 Accept in the Driver App sends one text from the Drivers API and none from the host', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    expect(driversAssignmentStatus(s.appacc.assignmentUuid)).toBe(DRIVERS_PENDING);
    const mark = driversLog.mark();

    const accepted = await sync.accept(s.appacc.assignmentUuid, randomUUID());
    expect(accepted.status(), await accepted.text()).toBe(202);

    await expect
      .poll(() => loggedTextsFrom(mark, DRIVERS_SMS_FROM), { message: 'the Drivers API logs the confirmation it would text', timeout: 30_000 })
      .toEqual([confirmationText(seed.jobDoc, 'Accept').length]);
    expect(driversAssignmentStatus(s.appacc.assignmentUuid)).toBe(DRIVERS_ACCEPTED);
    await expect.poll(() => hostAssignmentStatus(s.appacc.assignmentId), { message: 'JobAccepted reaches the host', timeout: 30_000 }).not.toBe(HOST_PENDING);
    expect(confirmationRowsOf(s.appacc.messageId)).toHaveLength(0);
  });

  test('REPCONF-07 Decline in the Driver App sends one text from the Drivers API, "you replied Decline. Thanks."', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    const mark = driversLog.mark();

    const declined = await mirror.reject(s.appdec.assignmentUuid, 'E2E-QC937-RC declined');
    expect(declined.status(), await declined.text()).toBe(202);

    await expect
      .poll(() => loggedTextsFrom(mark, DRIVERS_SMS_FROM), { message: 'the Drivers API logs the confirmation it would text', timeout: 30_000 })
      .toEqual([confirmationText(seed.jobDoc, 'Decline').length]);
    expect(driversAssignmentStatus(s.appdec.assignmentUuid)).toBe(DRIVERS_REJECTED);
    expect(confirmationRowsOf(s.appdec.messageId)).toHaveLength(0);
  });

  test('REPCONF-08 a Driver App reply with a button response code sends one text', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    const mark = driversLog.mark();

    const replied = await appReply.reply(s.appbtn.assignmentUuid, s.appbtn.messageUuid, 'accept', 'Accept');
    expect(replied.status(), await replied.text()).toBe(202);

    await expect
      .poll(() => loggedTextsFrom(mark, DRIVERS_SMS_FROM), { message: 'the Drivers API logs the confirmation it would text', timeout: 30_000 })
      .toEqual([confirmationText(seed.jobDoc, 'Accept').length]);
    expect(confirmationRowsOf(s.appbtn.messageId)).toHaveLength(0);
  });

  test('REPCONF-09 a Driver App reply with the response code question (a comment) sends no text', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    const mark = driversLog.mark();

    const replied = await appReply.reply(s.appq.assignmentUuid, s.appq.messageUuid, 'question', 'E2E-QC937-RC what time?');
    expect(replied.status(), await replied.text()).toBe(202);

    expect(
      queryDriversDb(`SELECT COUNT(*) FROM app.Messages WHERE ReplyToMessageUUID = '${s.appq.messageUuid}' AND IsFromDispatch = 0`),
      'the Drivers API stored the comment',
    ).toBe('1');
    expect(loggedTextsFrom(mark, DRIVERS_SMS_FROM)).toHaveLength(0);
  });

  test('REPCONF-10 with app.Hosts.ReplyConfirmation = 0 in DRIVERS an app Accept sends no text', async () => {
    test.skip(!linkedModeOn, 'Drivers:Mode is not On on this host, so the driver is not linked.');
    const before = driversHostRow(hostUuid);
    const mark = driversLog.mark();

    try {
      setDriversHostRow(hostUuid, { ...before, replyConfirmation: 0 });
      const accepted = await sync.accept(s.appoff.assignmentUuid, randomUUID());
      expect(accepted.status(), await accepted.text()).toBe(202);
      expect(driversAssignmentStatus(s.appoff.assignmentUuid)).toBe(DRIVERS_ACCEPTED);
      expect(loggedTextsFrom(mark, DRIVERS_SMS_FROM)).toHaveLength(0);
    } finally {
      setDriversHostRow(hostUuid, before);
    }
    expect(driversHostRow(hostUuid)).toEqual(before);
  });

  test('REPCONF-11 with Dispatch:ReplyConfirmation Off the host sends no text after a web answer', async () => {
    const setting = new HostReplyConfirmation(hostRequest);
    const original = setting.current();
    expect(original, 'the Dispatch:ReplyConfirmation setting exists (host/up/202611131401)').not.toBeNull();

    try {
      await setting.set('Off');
      const answer = await links.reply(s.off.code, { option: 'accept' });
      expect(answer.status, answer.text).toBe(200);
      expect(confirmationRowsOf(s.off.messageId)).toHaveLength(0);
    } finally {
      await setting.set(original!);
    }
    expect(setting.current()).toBe(original);
  });

  test('REPCONF-12 turning the setting Off or On reaches the Drivers API as app.Hosts.ReplyConfirmation 0 or 1', async () => {
    test.skip(!linkedModeOn, 'The host only sends HostDetailsChanged while Drivers:Mode is On.');
    const setting = new HostReplyConfirmation(hostRequest);
    const original = setting.current()!;

    try {
      await setting.set('Off');
      await expect.poll(() => driversHostRow(hostUuid).replyConfirmation, { message: 'HostDetailsChanged carries Off', timeout: 30_000 }).toBe(0);
      await setting.set('On');
      await expect.poll(() => driversHostRow(hostUuid).replyConfirmation, { message: 'HostDetailsChanged carries On', timeout: 30_000 }).toBe(1);
    } finally {
      if (setting.current() !== original) await setting.set(original);
    }
  });
});
