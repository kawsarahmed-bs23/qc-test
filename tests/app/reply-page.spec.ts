import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { APP_STATE, env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '@utils/localDb';
import { ASSIGNMENT_STATUS } from '@pages/message-link.page';
import { API_CHANNEL, CommsApi, MESSAGE_CHANNEL } from '@pages/comms-send-gate.page';
import { AI, InboundSmsApi, ReplyLinkApi, inboundBySid, messageRow, smsStaysLocal } from '@pages/reply-links.page';
import { toE164 } from '@pages/sms-framing.page';
import {
  ANSWERED_CHANNEL,
  LOCATION_REQUIRED,
  OPTED_OUT_ERROR,
  REPLY_PAGE_EN,
  REPLY_PAGE_ES,
  REPLY_PAGE_MARKER,
  assignmentStatusOf,
  driversHostName,
  driversHostUuid,
  driversMessageWatermark,
  driversOptOutOf,
  expectDriversAnswer,
  hostLinkAnswer,
  hostNoticeFor,
  latestDriversNotice,
  pickLinkedDriver,
  removeReplySlots,
  repliesTo,
  restoreDriversOptOut,
  restoreSmsOptOut,
  seedReplySlots,
  sharedLocationOf,
  smsOptOutOf,
  smsRowByMarker,
  threadOf,
  type LinkedDriver,
  type ReplySlot,
} from '@pages/reply-page.page';
import { DriversMirrorApi } from '@api/drivers-mirror.api';

const POSITION = { latitude: 30.2672, longitude: -97.7431 };
const SID_PREFIX = `SME947${Date.now()}`;
const THROWAWAY_DRIVER_EMAIL = 'e2e.qc947.driver@quarryconnect.test';
const THROWAWAY_DRIVER_PHONE = '5125559947';

test.describe('Driver reply page at the host address (QC-947, QC-948)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(
    env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb(),
    'Needs the local host and DRIVERS databases to seed reply links and read answers.',
  );
  test.skip(!env.appUrl || !env.appApiUrl, 'APP_URL / APP_API_URL are not set, so the reply page and its API cannot be opened.');
  test.use({ ...signedOut, geolocation: POSITION, permissions: ['geolocation'] });

  let hostUuid: string;
  let driver: LinkedDriver;
  let watermark: number;
  let s: Record<string, ReplySlot>;
  let links: ReplyLinkApi;

  test.beforeAll(() => {
    hostUuid = driversHostUuid();
    driver = pickLinkedDriver(hostUuid);
    watermark = driversMessageWatermark();
    s = seedReplySlots({ driverId: driver.id, templateDriverId: driver.id, hostUuid }, [
      { slot: 'look', type: 10, state: 'open' },
      { slot: 'accept', type: 10, state: 'open' },
      { slot: 'race', type: 10, state: 'open' },
      { slot: 'spanish', type: 10, state: 'open' },
      { slot: 'status', type: 20, state: 'open' },
      { slot: 'expired', type: 10, state: 'expired' },
      { slot: 'withdrawn', type: 10, state: 'withdrawn' },
      { slot: 'app', type: 10, state: 'app' },
    ]);
  });

  test.beforeEach(async () => {
    links = await ReplyLinkApi.open();
  });

  test.afterEach(async () => {
    await links?.close();
  });

  test.afterAll(() => {
    if (driver) removeReplySlots(driver.id, watermark, SID_PREFIX);
  });

  test('RPAGE-01 /m/{code} opens signed out at #/m/{code} with no app shell, a noindex robots tag and the job offer', async ({ replyPage }) => {
    await replyPage.open(s.look.code);
    await replyPage.expectStandalone(s.look.code);
    await expect(replyPage.card).toHaveAttribute('data-state', 'open');
    await expect(replyPage.title).toHaveText(REPLY_PAGE_EN.jobOffer);
    await replyPage.expectOptions([REPLY_PAGE_EN.options.accept, REPLY_PAGE_EN.options.cant, REPLY_PAGE_EN.options.question]);
    await expect(replyPage.answer).toHaveCount(0);
    await replyPage.attachScreenshot('reply-page-job-offer');
  });

  test('RPAGE-02 Accept on a job offer shows "You replied Accept on the web at ...", drops the buttons, accepts the assignment and tells DRIVERS (accept, web)', async ({
    replyPage,
  }) => {
    expect(assignmentStatusOf(s.accept.assignmentId)).toBe(ASSIGNMENT_STATUS.Pending);
    await replyPage.open(s.accept.code);
    await replyPage.choose('accept');
    await replyPage.expectAnswered(REPLY_PAGE_EN.options.accept, 'on the web');
    await expect(replyPage.addComment).toBeVisible();

    const link = hostLinkAnswer(s.accept.messageId);
    expect(link).toMatchObject({ option: 'accept', channel: ANSWERED_CHANNEL.Web });
    expect(link.answerMessageId).not.toBeNull();
    expect(assignmentStatusOf(s.accept.assignmentId)).toBe(ASSIGNMENT_STATUS.Accepted);
    expect(repliesTo(s.accept.messageId)).toEqual([{ id: link.answerMessageId!, channel: MESSAGE_CHANNEL.Link, body: REPLY_PAGE_EN.options.accept }]);
    await expectDriversAnswer(s.accept.messageUuid, 'accept', 'web');

    await replyPage.open(s.accept.code);
    await replyPage.expectAnswered(REPLY_PAGE_EN.options.accept, 'on the web');
  });

  test('RPAGE-03 an offer answered elsewhere while the page was open refuses a second option, shows the first answer, and still takes a comment', async ({
    replyPage,
  }) => {
    await replyPage.open(s.race.code);
    await expect(replyPage.option('cant')).toBeVisible();
    const first = await links.reply(s.race.code, { option: 'accept' });
    expect(first.status, first.text).toBe(200);

    await replyPage.choose('cant');
    await expect(replyPage.error).toHaveText(REPLY_PAGE_EN.alreadyAnswered);
    await replyPage.expectAnswered(REPLY_PAGE_EN.options.accept, 'on the web');
    expect(assignmentStatusOf(s.race.assignmentId), 'the refused Decline changes nothing').toBe(ASSIGNMENT_STATUS.Accepted);
    expect(hostLinkAnswer(s.race.messageId).option).toBe('accept');

    const comment = `${REPLY_PAGE_MARKER} running ten minutes behind`;
    await replyPage.comment(comment);
    await expect(replyPage.notice).toHaveText(REPLY_PAGE_EN.commentSent);
    const replies = repliesTo(s.race.messageId);
    expect(replies).toHaveLength(2);
    expect(replies[1]).toMatchObject({ channel: MESSAGE_CHANNEL.Link, body: comment });
    expect(hostLinkAnswer(s.race.messageId).answerMessageId, 'a comment does not replace the answer').toBe(replies[0].id);
  });

  test('RPAGE-04 the ES toggle shows the offer in Spanish (Oferta de trabajo; Aceptar, Rechazar, Comentario) and keeps it after a reload; EN switches back', async ({
    replyPage,
  }) => {
    await replyPage.open(s.spanish.code);
    await expect(replyPage.title).toHaveText(REPLY_PAGE_EN.jobOffer);
    await replyPage.spanish.click();
    await expect(replyPage.title).toHaveText(REPLY_PAGE_ES.jobOffer);
    await replyPage.expectOptions([REPLY_PAGE_ES.options.accept, REPLY_PAGE_ES.options.cant, REPLY_PAGE_ES.options.question]);

    await replyPage.open(s.spanish.code);
    await expect(replyPage.title).toHaveText(REPLY_PAGE_ES.jobOffer);

    await replyPage.english.click();
    await expect(replyPage.title).toHaveText(REPLY_PAGE_EN.jobOffer);
    await replyPage.expectOptions([REPLY_PAGE_EN.options.accept, REPLY_PAGE_EN.options.cant, REPLY_PAGE_EN.options.question]);
    expect(hostLinkAnswer(s.spanish.messageId).option, 'switching language answers nothing').toBeNull();
  });

  test('RPAGE-05 a status check offers Share my location and Comment; the API refuses location without a position, the page shares the browser position as a manual TripGps ping and DRIVERS gets share-location', async ({
    replyPage,
  }) => {
    const bare = await links.reply(s.status.code, { option: 'location' });
    expect(bare.status, bare.text).toBe(400);
    expect(bare.text).toContain(LOCATION_REQUIRED);
    expect(sharedLocationOf(s.status.assignmentId).count).toBe(0);

    await replyPage.open(s.status.code);
    await expect(replyPage.title).toHaveText(REPLY_PAGE_EN.statusCheck);
    await replyPage.expectOptions([REPLY_PAGE_EN.options.location, REPLY_PAGE_EN.options.question]);
    await replyPage.choose('location');
    await replyPage.expectAnswered(REPLY_PAGE_EN.options.location, 'on the web');

    const ping = sharedLocationOf(s.status.assignmentId);
    expect(ping).toMatchObject({ count: 1, isManual: 1, deviceId: 'reply-link' });
    expect(ping.lat).toBeCloseTo(POSITION.latitude, 4);
    expect(ping.lon).toBeCloseTo(POSITION.longitude, 4);
    expect(hostLinkAnswer(s.status.messageId)).toMatchObject({ option: 'location', channel: ANSWERED_CHANNEL.Web });
    expect(assignmentStatusOf(s.status.assignmentId), 'sharing a location changes no status').toBe(ASSIGNMENT_STATUS.Accepted);
    await expectDriversAnswer(s.status.messageUuid, 'share-location', 'web');
  });

  test('RPAGE-06 an expired and a withdrawn offer show their closed text and no buttons, and still take a comment', async ({ replyPage }) => {
    for (const [slot, state, text] of [
      [s.expired, 'expired', REPLY_PAGE_EN.expired],
      [s.withdrawn, 'withdrawn', REPLY_PAGE_EN.withdrawn],
    ] as const) {
      await replyPage.open(slot.code);
      await expect(replyPage.card).toHaveAttribute('data-state', state);
      await expect(replyPage.closed).toHaveText(text);
      await expect(replyPage.options).toHaveCount(0);

      const comment = `${REPLY_PAGE_MARKER} ${state} comment`;
      await replyPage.comment(comment);
      await expect(replyPage.notice).toHaveText(REPLY_PAGE_EN.commentSent);
      expect(repliesTo(slot.messageId)).toEqual([expect.objectContaining({ channel: MESSAGE_CHANNEL.Link, body: comment })]);
      expect(hostLinkAnswer(slot.messageId).option, `a comment on a ${state} link answers nothing`).toBeNull();
    }
  });

  test('RPAGE-07 an unknown code shows the not-found text and no card', async ({ replyPage }) => {
    await replyPage.open('Zz9QC947xx');
    await expect(replyPage.notFound).toHaveText(REPLY_PAGE_EN.notFound);
    await expect(replyPage.card).toHaveCount(0);
  });

  test('RPAGE-08 an offer already answered in the app (AnsweredChannel 20) shows "You replied Accept in the app at ..." with no buttons', async ({
    replyPage,
  }) => {
    const view = await links.get(s.app.code);
    expect(view.view!.reply).toMatchObject({ option: 'accept', channel: 'app' });
    expect(view.view!.reply!.atText).toMatch(/^\d{1,2}:\d{2} (AM|PM)$/);

    await replyPage.open(s.app.code);
    await replyPage.expectAnswered(REPLY_PAGE_EN.options.accept, 'in the app');
    await expect(replyPage.answer).toHaveText(`You replied Accept in the app at ${view.view!.reply!.atText}`);
    await expect(replyPage.addComment).toBeVisible();
  });

  test.describe('SMS STOP and START (QC-947, QC-948)', () => {
    test.use({ storageState: APP_STATE });

    test('RPAGE-09 STOP from the driver blocks host texts (SmsOptOuts, System notice, DRIVERS SmsOptedOut and notice); START turns them on again', async ({
      page,
    }) => {
      test.skip(!smsStaysLocal(), 'Twilio FromPhoneNumber is set and Twilio:ApiBaseAddress is not a local stub, so an SMS would really go out.');
      const phone = toE164(driver.phone);
      const optOut = smsOptOutOf(phone);
      const driversOptOut = driversOptOutOf(driver.id, hostUuid);
      const hostName = (await links.get(s.look.code)).view!.host.name!;
      const driversHost = driversHostName(hostUuid);
      const inbound = await InboundSmsApi.open();
      let sids = 0;
      const receive = async (body: string) => {
        const sid = `${SID_PREFIX}${sids++}`;
        const status = await inbound.receive(sid, phone, body);
        test.skip(status === 403, 'The local API validates Twilio signatures (Twilio:ValidateSignature), so an unsigned webhook is refused.');
        expect(status, `inbound SMS "${body}"`).toBe(204);
        const id = inboundBySid(sid);
        expect(id, `the stored inbound SMS "${body}"`).not.toBeNull();
        return id!;
      };

      try {
        const stop = await receive('Stop.');
        expect(messageRow(stop)).toMatchObject({ ai: AI.Noted, isActioned: 1, body: 'Stop.' });
        expect(smsOptOutOf(phone)).toMatchObject({ exists: true, optedOut: 1, keyword: 'STOP' });
        expect(hostNoticeFor(stop)).toMatchObject({
          messageType: 50,
          isActioned: 1,
          body: `${driver.name} replied STOP: texts from ${hostName} are blocked until they reply START.`,
        });
        await expect.poll(() => driversOptOutOf(driver.id, hostUuid).smsOptedOut, { message: 'SmsOptOutChanged reaches DRIVERS', timeout: 30_000 }).toBe(1);
        await expect
          .poll(() => latestDriversNotice(driver.id, watermark), { timeout: 30_000 })
          .toMatch(new RegExp(`^You replied STOP\\. Texts from ${escapeRegex(driversHost)} are now blocked unless you reply START to \\S+\\.$`));

        await page.goto('/');
        const comms = new CommsApi(page, env.appApiUrl!);
        await comms.ready();
        const marker = `${REPLY_PAGE_MARKER} optout ${Date.now()}`;
        const sent = await comms.send(driver.id, marker, API_CHANNEL.Sms);
        expect(sent.status, sent.text).toBe(200);
        expect(smsRowByMarker(marker), 'an SMS to an opted-out phone is stored but not sent').toEqual({ error: OPTED_OUT_ERROR, sid: null });

        const start = await receive('start');
        expect(smsOptOutOf(phone)).toMatchObject({ optedOut: 0, keyword: 'START' });
        expect(hostNoticeFor(start)!.body).toBe(`${driver.name} replied START: texts from ${hostName} are on again.`);
        await expect.poll(() => driversOptOutOf(driver.id, hostUuid).smsOptedOut, { timeout: 30_000 }).toBe(0);
        await expect
          .poll(() => latestDriversNotice(driver.id, watermark), { timeout: 30_000 })
          .toBe(`You replied START. Texts from ${driversHost} are on again.`);
      } finally {
        await inbound.close();
        restoreSmsOptOut(phone, optOut);
        restoreDriversOptOut(driver.id, hostUuid, driversOptOut);
      }
    });
  });

  test.describe('Drivers API shows the web answer and refuses a second one (QC-948)', () => {
    test.skip(
      !canUseIdentityDb() || !env.admin || !env.driversApiUrl || !env.mobileClientId,
      "Needs Identity's local database, ADMIN_EMAIL / ADMIN_PASSWORD and the Drivers API.",
    );

    let throwaway: string;
    let offer: ReplySlot;

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc947-user.apply.sql', { Email: THROWAWAY_DRIVER_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-947 Driver' });
      throwaway = queryIdentityDb(`SELECT LOWER(Id) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${THROWAWAY_DRIVER_EMAIL}')`)!;
      expect(throwaway, 'the throwaway Identity driver exists').toBeTruthy();
      offer = seedReplySlots(
        { driverId: throwaway, templateDriverId: driver.id, hostUuid, newDriver: { email: THROWAWAY_DRIVER_EMAIL, phone: THROWAWAY_DRIVER_PHONE } },
        [{ slot: 'drivers', type: 10, state: 'open' }],
      ).drivers;
    });

    test.afterAll(() => {
      try {
        if (throwaway) removeReplySlots(throwaway, watermark, SID_PREFIX);
      } finally {
        runIdentitySeedScript('identity-qc947.remove.sql');
      }
    });

    test('RPAGE-10 after a web Accept, GET /driver-message/threads/{uuid} shows the answer and smsOptedOut false, and POST /driver-message/send with responseCode answers 409 "Already answered"', async ({
      request,
      passwordGrantApi,
    }) => {
      const answered = await links.reply(offer.code, { option: 'accept' });
      expect(answered.status, answered.text).toBe(200);
      await expectDriversAnswer(offer.messageUuid, 'accept', 'web');

      const token = await passwordGrantApi.passwordGrant(THROWAWAY_DRIVER_EMAIL, env.admin!.password);
      expect(token.status, JSON.stringify(token.body)).toBe(200);
      const drivers = new DriversMirrorApi(request, token.body.access_token!);

      const thread = await threadOf(await drivers.send({ method: 'GET', path: `/driver-message/threads/${offer.assignmentUuid}` }, hostUuid));
      expect(thread.smsOptedOut).toBe(false);
      const message = thread.messages.find((m) => m.messageUuid.toLowerCase() === offer.messageUuid);
      expect(message, 'the seeded offer message in the thread').toBeDefined();
      expect(message!.answer).toMatchObject({ responseCode: 'accept', label: 'Accept', channel: 'web', comment: null });
      expect(message!.answer!.text).toMatch(/^You replied Accept on the web at \d{1,2}:\d{2} (AM|PM)$/);
      expect(message!.replyRejected).toBe(false);

      const second = await drivers.send(
        {
          method: 'POST',
          path: '/driver-message/send',
          data: { orderAssignmentUuid: offer.assignmentUuid, messageBody: 'Decline', replyToMessageUuid: offer.messageUuid, responseCode: 'reject' },
        },
        hostUuid,
      );
      expect(second.status(), await second.text()).toBe(409);
      expect((await second.json()).errors[0]).toMatch(/^Already answered: Accept, on the web at \d{1,2}:\d{2} (AM|PM)$/);

      const reject = await drivers.send(
        { method: 'POST', path: `/driver-assignment/reject-assignment/${offer.assignmentUuid}`, data: { note: 'e2e-qc947' } },
        hostUuid,
      );
      expect(reject.status(), await reject.text()).toBe(409);
      expect(assignmentStatusOf(offer.assignmentId)).toBe(ASSIGNMENT_STATUS.Accepted);
    });
  });
});

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
