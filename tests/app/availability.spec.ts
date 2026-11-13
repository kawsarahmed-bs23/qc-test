import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb } from '@utils/localDb';
import { MESSAGE_CHANNEL } from '@pages/comms-send-gate.page';
import { ReplyLinkApi } from '@pages/reply-links.page';
import { REPLY_PAGE_EN } from '@pages/reply-page.page';
import {
  AVAILABILITY_QUESTION,
  AVAILABILITY_TYPE,
  SEEDED_VENDOR,
  answerOf,
  appDay,
  askSince,
  canReach,
  driversMessagingEndpoint,
  driversGeneralMessage,
  isoDay,
  nextMondayOffset,
  pickDrivers,
  removeAvailability,
  seedAvailability,
  watermarks,
  AvailabilityReplyPage,
  type AvailabilityDrivers,
  type AvailabilityPeriod,
  type AvailabilitySlot,
  type AvailabilityWatermarks,
} from '@pages/availability.page';

const NO_ORDER = 0;
const MONDAY = nextMondayOffset();
const truckLabel = (tag?: string) => new RegExp(String.raw`^\s*#TR-RM-0001 – [^·]*${tag ? String.raw` · ${tag}\s*$` : '$'}`);

const ANSWERED_WEB = /^You replied (.+) on the web at \d{1,2}:\d{2} (AM|PM)$/;

test.describe('Availability messages: today, tomorrow and next week (QC-931)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(
    env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb(),
    'Needs the local host and DRIVERS databases to seed questions and read what the API stored.',
  );
  test.skip(!env.appUrl || !env.appApiUrl, 'APP_URL / APP_API_URL are not set.');

  let drivers: AvailabilityDrivers;
  let marks: AvailabilityWatermarks;
  let slots: Record<string, AvailabilitySlot>;

  test.beforeAll(() => {
    drivers = pickDrivers();
    marks = watermarks();
    const seeded = seedAvailability(
      drivers.askedId,
      [
        { slot: 'today', period: 'today', dayOffset: 0, state: 'open' },
        { slot: 'tomorrow', period: 'tomorrow', dayOffset: 1, state: 'open' },
        { slot: 'week', period: 'next-week', dayOffset: MONDAY, state: 'open' },
        { slot: 'race', period: 'today', dayOffset: 0, state: 'open' },
        { slot: 'weekno', period: 'next-week', dayOffset: MONDAY + 14, state: 'open' },
        { slot: 'commenttoday', period: 'today', dayOffset: 0, state: 'open' },
        { slot: 'yestoday', period: 'today', dayOffset: 0, state: 'yes' },
        { slot: 'weekdays', period: 'next-week', dayOffset: MONDAY, state: 'days' },
      ],
      NO_ORDER,
    );
    slots = seeded.slots;
  });

  test.afterAll(() => {
    if (drivers) removeAvailability([drivers.askedId, drivers.linkedId], [drivers.askedId, drivers.linkedUuid], marks);
  });

  test.describe('Ask availability in Dispatch Comms', () => {
    const periods: { id: string; period: AvailabilityPeriod; label: string; offset: number }[] = [
      { id: 'AVAIL-01', period: 'today', label: 'Today', offset: 0 },
      { id: 'AVAIL-02', period: 'tomorrow', label: 'Tomorrow', offset: 1 },
      { id: 'AVAIL-03', period: 'next-week', label: 'Next week', offset: MONDAY },
    ];

    for (const { id, period, label, offset } of periods) {
      test(`${id} Ask availability > ${label} sends the question to a Driver App driver, shows the success notice and an "Availability ${period.replace('-', ' ')}" tagged bubble`, async ({
        availabilityComms,
        commsPage,
      }) => {
        const before = watermarks().host;
        await availabilityComms.open(drivers.askedId);
        if (period === 'today') await availabilityComms.expectPeriodsOffered();
        await availabilityComms.ask(period);
        await expect(availabilityComms.sentNotice).toBeVisible();

        const stored = askSince(drivers.askedId, before, AVAILABILITY_TYPE[period]);
        expect(stored, `a stored ${period} availability question`).not.toBeNull();
        expect(stored!.channel, 'a Driver App driver gets it in the app').toBe(MESSAGE_CHANNEL.InApp);
        expect(stored!.body).toContain(AVAILABILITY_QUESTION[period]);
        expect(stored!.availabilityDate).toBe(isoDay(appDay(offset)));
        expect(stored!.hasReplyLink, 'a reply link is made').toBe(true);

        await availabilityComms.expectTagged(stored!.id, period);
        await expect(commsPage.messageText(stored!.id)).toContainText(AVAILABILITY_QUESTION[period]);
        await expect(commsPage.channelBadge(stored!.id)).toContainText('App');
      });
    }

    test('AVAIL-04 the Ask availability button is enabled for a driver who can be asked', async ({ availabilityComms }) => {
      await availabilityComms.open(drivers.askedId);
      await expect(availabilityComms.askButton).toBeEnabled();
    });
  });

  test.describe('Reply page for an availability question', () => {
    test.use({ ...signedOut });

    test('AVAIL-05 today: the page asks "Are you available for work today?" with Yes, No and Comment', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.today.code);
      await availabilityReplyPage.expectStandalone(slots.today.code);
      await availabilityReplyPage.expectQuestion('today');
      await availabilityReplyPage.expectOptions(['Yes', 'No', REPLY_PAGE_EN.options.question]);
      await expect(availabilityReplyPage.answer).toHaveCount(0);
    });

    test('AVAIL-06 tomorrow: the page asks the tomorrow question with Yes, No and Comment', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.tomorrow.code);
      await availabilityReplyPage.expectQuestion('tomorrow');
      await availabilityReplyPage.expectOptions(['Yes', 'No', REPLY_PAGE_EN.options.question]);
    });

    test('AVAIL-07 next week: the page offers Yes, Only these days, No and Comment', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.week.code);
      await availabilityReplyPage.expectQuestion('next-week');
      await availabilityReplyPage.expectOptions(['Yes', 'Only these days', 'No', REPLY_PAGE_EN.options.question]);
    });

    test('AVAIL-08 Yes on today shows "You replied Yes on the web at ...", drops the buttons and stores yes on the web', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.today.code);
      await availabilityReplyPage.choose('yes');
      await availabilityReplyPage.expectAnswered('Yes', 'on the web');
      await expect(availabilityReplyPage.answer).toHaveText(ANSWERED_WEB);

      const stored = answerOf(slots.today.messageId);
      expect(stored.option).toBe('yes');
      expect(stored.channel).toBe(MESSAGE_CHANNEL.Link);
      expect(stored.answerBody).toBe('Yes');

      await availabilityReplyPage.open(slots.today.code);
      await availabilityReplyPage.expectAnswered('Yes', 'on the web');
    });

    test('AVAIL-09 No on tomorrow is stored as no', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.tomorrow.code);
      await availabilityReplyPage.choose('no');
      await availabilityReplyPage.expectAnswered('No', 'on the web');
      const stored = answerOf(slots.tomorrow.messageId);
      expect(stored.option).toBe('no');
      expect(stored.answerBody).toBe('No');
    });

    test('AVAIL-10 Only these days needs a comment: it opens the comment box, refuses an empty one and stores the days', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.week.code);
      await availabilityReplyPage.choose('only-days');
      await expect(availabilityReplyPage.commentForm).toBeVisible();
      await availabilityReplyPage.send.click();
      await expect(availabilityReplyPage.answer, 'an empty comment does not answer').toHaveCount(0);
      expect(answerOf(slots.week.messageId).option).toBeNull();

      await availabilityReplyPage.commentTextArea.fill('Tue and Wed only');
      await availabilityReplyPage.send.click();
      await expect(availabilityReplyPage.answer).toHaveText(/^You replied Only these days on the web at \d{1,2}:\d{2} (AM|PM)$/);

      const stored = answerOf(slots.week.messageId);
      expect(stored.option).toBe('only-days');
      expect(stored.channel).toBe(MESSAGE_CHANNEL.Link);
      expect(stored.answerBody).toBe('Only these days: Tue and Wed only');
    });

    test('AVAIL-11 the first answer wins: an answer given elsewhere while the page is open refuses a second one and keeps the first', async ({
      availabilityReplyPage,
    }) => {
      const links = await ReplyLinkApi.open();
      try {
        await availabilityReplyPage.open(slots.race.code);
        const first = await links.replyOnce(slots.race.code, { option: 'yes' });
        expect(first.status, first.text).toBe(200);

        await availabilityReplyPage.choose('no');
        await expect(availabilityReplyPage.error.or(availabilityReplyPage.notice)).toContainText(REPLY_PAGE_EN.alreadyAnswered);
        const stored = answerOf(slots.race.messageId);
        expect(stored.option).toBe('yes');
        expect(stored.answerBody).toBe('Yes');
      } finally {
        await links.close();
      }
    });

    test('AVAIL-12 Comment needs text and answers the question with that comment', async ({ availabilityReplyPage }) => {
      await availabilityReplyPage.open(slots.weekno.code);
      await availabilityReplyPage.choose('question');
      await availabilityReplyPage.send.click();
      expect(answerOf(slots.weekno.messageId).option, 'an empty comment does not answer').toBeNull();

      await availabilityReplyPage.commentTextArea.fill('Call me about the schedule');
      await availabilityReplyPage.send.click();
      await expect(availabilityReplyPage.answer).toHaveText(/^You replied Comment on the web at \d{1,2}:\d{2} (AM|PM)$/);
      await expect(availabilityReplyPage.card).toContainText('Call me about the schedule');
      const stored = answerOf(slots.weekno.messageId);
      expect(stored.option).toBe('question');
      expect(stored.channel).toBe(MESSAGE_CHANNEL.Link);
      expect(stored.answerBody).toContain('Call me about the schedule');
    });
  });

  test('AVAIL-13 the answers show in Dispatch Comms as inbound messages with the Web badge', async ({ availabilityComms, commsPage }) => {
    const today = answerOf(slots.today.messageId);
    const week = answerOf(slots.week.messageId);
    expect(today.answerId).not.toBeNull();
    expect(week.answerId).not.toBeNull();

    await availabilityComms.open(drivers.askedId);
    await expect(commsPage.messageText(today.answerId!)).toHaveText('Yes');
    await expect(commsPage.channelBadge(today.answerId!)).toContainText('Web');
    await expect(commsPage.messageText(week.answerId!)).toContainText('Only these days: Tue and Wed only');
    await expect(commsPage.channelBadge(week.answerId!)).toContainText('Web');
    await availabilityComms.expectTagged(slots.today.messageId, 'today');
    await availabilityComms.expectTagged(slots.week.messageId, 'next-week');
  });

  test.describe('Assign Truck shows the answer on the truck option', () => {
    test('AVAIL-14 a Yes for today tags the truck "Available" on today and not on a date the answer does not cover; the truck stays selectable', async ({
      assignAvailabilityPage: assign,
    }) => {
      await assign.openForVendor(SEEDED_VENDOR);
      await assign.openTruckList();
      await expect(assign.truckOption(drivers.askedTruckId)).toHaveText(truckLabel('Available'));
      await expect(assign.truckOption(drivers.askedTruckId)).not.toHaveAttribute('aria-disabled', 'true');
      await assign.closeTruckList();

      await assign.setDate(appDay(MONDAY + 7));
      await assign.openTruckList();
      await expect(assign.truckOption(drivers.askedTruckId)).toHaveText(truckLabel());
      await expect(assign.truckOption(drivers.askedTruckId)).not.toContainText('·');
      await assign.truckOption(drivers.askedTruckId).click();
      await expect(assign.truck).toContainText('#TR-RM-0001');
    });

    test('AVAIL-15 an Only these days answer for next week tags the truck on a day of that week, with the comment as its tooltip, and not the week after', async ({
      assignAvailabilityPage: assign,
      commsPage,
    }) => {
      await assign.openForVendor(SEEDED_VENDOR);
      await assign.setDate(appDay(MONDAY + 1));
      await assign.openTruckList();
      await expect(assign.truckOption(drivers.askedTruckId)).toHaveText(truckLabel('Only these days'));
      await assign.truckOption(drivers.askedTruckId).hover();
      await expect(commsPage.tooltip()).toHaveText('Tue and Wed only');
      await assign.truckOption(drivers.askedTruckId).click();
      await expect(assign.truck).toContainText('Only these days');

      await assign.setDate(appDay(MONDAY + 7));
      await assign.openTruckList();
      await expect(assign.truckOption(drivers.askedTruckId)).not.toContainText('·');
    });

    test('AVAIL-16 a No answer tags the truck "Not available" and the truck is still not disabled by it', async ({ assignAvailabilityPage: assign }) => {
      await assign.openForVendor(SEEDED_VENDOR);
      await assign.setDate(appDay(1));
      await assign.openTruckList();
      await expect(assign.truckOption(drivers.askedTruckId)).toHaveText(truckLabel('Not available'));
      await expect(assign.truckOption(drivers.askedTruckId)).not.toHaveAttribute('aria-disabled', 'true');
      await assign.truckOption(drivers.askedTruckId).click();
      await expect(assign.truck).toContainText('Not available');
    });
  });

  test('AVAIL-18 a later Comment on a newer ask for the same date does not remove the Available tag from an earlier Yes', async ({
    browser,
    assignAvailabilityPage: assign,
  }) => {
    const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: true, baseURL: env.appUrl ?? undefined });
    try {
      const reply = new AvailabilityReplyPage(await context.newPage());
      await reply.open(slots.commenttoday.code);
      await reply.choose('question');
      await reply.commentTextArea.fill('Running late, call me');
      await reply.send.click();
      await expect(reply.answer).toHaveText(/^You replied Comment on the web at \d{1,2}:\d{2} (AM|PM)$/);
    } finally {
      await context.close();
    }
    expect(answerOf(slots.commenttoday.messageId).option).toBe('question');

    await assign.openForVendor(SEEDED_VENDOR);
    await assign.openTruckList();
    await expect(assign.truckOption(drivers.askedTruckId)).toHaveText(truckLabel('Available'));
  });

  test('AVAIL-17 a question to a driver linked in DRIVERS reaches the Drivers API as a general-thread message (no assignment)', async ({
    availabilityComms,
  }) => {
    const hostBefore = watermarks().host;
    const driversBefore = watermarks().drivers;
    await availabilityComms.open(drivers.linkedId);
    await availabilityComms.ask('today');
    await expect(availabilityComms.sentNotice).toBeVisible();

    const host = askSince(drivers.linkedId, hostBefore, AVAILABILITY_TYPE.today);
    expect(host, 'a stored question for the linked driver').not.toBeNull();
    expect(host!.channel).toBe(MESSAGE_CHANNEL.InApp);

    const endpoint = driversMessagingEndpoint();
    test.skip(
      !endpoint || !(await canReach(endpoint)),
      'The Drivers API is not listening on the host Messaging:DriversEndpoint, so MessageSent stays in the host outbox and never reaches DRIVERS.',
    );
    await expect
      .poll(() => driversGeneralMessage(drivers.linkedUuid, driversBefore, AVAILABILITY_TYPE.today), {
        message: 'MessageSent reaches DRIVERS as a general-thread message',
        timeout: 30_000,
      })
      .not.toBeNull();
    const stored = driversGeneralMessage(drivers.linkedUuid, driversBefore, AVAILABILITY_TYPE.today)!;
    expect(stored.assignmentUuid).toBeNull();
    expect(stored.fromDispatch).toBe(true);
    expect(stored.body).toContain(AVAILABILITY_QUESTION.today);
  });
});
