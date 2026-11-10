import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { DateStrip } from '@pages/app.page';
import { CommsHostAdmin, QC804_ADMIN_STATE } from '@pages/comms-send-gate.page';
import { CommsDayApi, CommsDayPage, dayLabel, isoToLocalDate } from '@pages/comms-day.page';

const MARKER = 'E2E-QC806';
const APP_ZONE = 'America/Chicago';
const APP_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)`;
const TODAY_START_UTC = `CAST(CAST(${APP_TODAY} AS datetime) AT TIME ZONE 'Central Standard Time' AT TIME ZONE 'UTC' AS datetime)`;
const DRIVER = `u.IsActive = 1 AND u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName = 'Driver')`;
const NOTHING_TODAY_OR_TOMORROW = `NOT EXISTS (SELECT 1 FROM app.Messages m WHERE m.DriverUserID_FK = u.Id AND m.Active = 1
      AND m.Created >= ${TODAY_START_UTC} AND m.MessageBody NOT LIKE N'%${MARKER}%')
    AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id AND a.Active = 1
      AND a.AssignmentDate BETWEEN ${APP_TODAY} AND DATEADD(DAY, 1, ${APP_TODAY}) AND ISNULL(a.Notes, '') <> N'${MARKER}')`;
const OWN_MESSAGES = `(SELECT COUNT(*) FROM app.Messages m WHERE m.DriverUserID_FK = u.Id AND m.MessageBody NOT LIKE N'%${MARKER}%')`;

interface Seeded {
  a: string;
  b: string;
  c: string;
  assignmentA: number;
  assignmentB: number;
  latest: number;
}

function pickDriver(exclude: string[], extra = ''): string {
  const notIn = exclude.length ? `AND u.Id NOT IN (${exclude.map((id) => `N'${id}'`).join(', ')})` : '';
  const id = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${DRIVER} AND ${NOTHING_TODAY_OR_TOMORROW} ${notIn} ${extra}
    ORDER BY ${OWN_MESSAGES}, u.Id`);
  if (!id) throw new Error('QC-806 needs three active drivers with no messages or live assignments today or tomorrow.');
  return id;
}

function seed(): Seeded {
  const a = pickDriver([]);
  const c = pickDriver([a], `AND ISNULL(u.PhoneNumber, '') <> ''`);
  const b = pickDriver([a, c]);
  const output = runSeedScript('comms-day-qc806.apply.sql', { DriverA: a, DriverB: b });
  const line = output.split(/\r?\n/).find((l) => l.includes('SEED order='));
  if (!line) {
    runSeedScript('comms-day-qc806.remove.sql');
    throw new Error(`The QC-806 seed did not report its rows:\n${output}`);
  }
  const values = Object.fromEntries(
    line
      .trim()
      .replace(/^SEED /, '')
      .split(';')
      .map((p) => p.split('='))
      .map(([k, v]) => [k, Number(v)]),
  );
  return { a, b, c, assignmentA: values.a, assignmentB: values.b, latest: values.latest };
}

function isoDate(offsetDays: number): string {
  return querySingleValue(`SELECT CONVERT(varchar(10), DATEADD(DAY, ${offsetDays}, ${APP_TODAY}), 23)`) ?? '';
}

function idList(query: string): number[] {
  const value = querySingleValue(`SELECT STRING_AGG(CAST(x.Id AS varchar(20)), ',') WITHIN GROUP (ORDER BY x.Created, x.Id)
    FROM (${query}) x`);
  return value ? value.split(',').map(Number) : [];
}

function earlierThanToday(driver: string): number[] {
  return idList(`SELECT MessageID AS Id, Created FROM app.Messages WHERE Active = 1 AND DriverUserID_FK = N'${driver}' AND Created < ${TODAY_START_UTC}`);
}

function todayIds(driver: string): number[] {
  return idList(`SELECT MessageID AS Id, Created FROM app.Messages WHERE Active = 1 AND DriverUserID_FK = N'${driver}'
    AND Created >= ${TODAY_START_UTC} AND Created < DATEADD(DAY, 1, ${TODAY_START_UTC})`);
}

function label(...parts: string[]): RegExp {
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(escaped.join('\\s+·\\s+'));
}

async function snapshot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('Comms: pick a day, start a conversation with any driver, and page back through history (QC-806)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed assignments and messages.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the threads and earlier-messages API cannot be called directly.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.use({ storageState: QC804_ADMIN_STATE, timezoneId: env.appTimeZone ?? APP_ZONE });

  let s: Seeded;
  let today: string;
  let tomorrow: string;
  const names: Record<'a' | 'b' | 'c', string> = { a: '', b: '', c: '' };

  test.beforeAll(async ({ browser }) => {
    await CommsHostAdmin.signIn(browser);
    s = seed();
    today = isoDate(0);
    tomorrow = isoDate(1);
  });

  test.afterAll(() => {
    try {
      runSeedScript('comms-day-qc806.remove.sql');
    } finally {
      CommsHostAdmin.remove();
    }
  });

  async function api(page: Page): Promise<CommsDayApi> {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const client = new CommsDayApi(page, env.appApiUrl!);
    await client.ready();
    if (!names.a) {
      names.a = (await client.thread(s.a)).driverName ?? '';
      names.b = (await client.thread(s.b)).driverName ?? '';
      names.c = (await client.thread(s.c)).driverName ?? '';
    }
    return client;
  }

  async function openComms(page: Page, query: { date?: string; driverId?: string }): Promise<CommsDayPage> {
    const comms = new CommsDayPage(page);
    const date = query.date ?? today;
    const threads = comms.waitForThreads(date);
    const thread = query.driverId ? comms.waitForThread(query.driverId, date) : null;
    await comms.open(query);
    expect((await threads).ok(), `GET threads?date=${date}`).toBe(true);
    if (thread) expect((await thread).ok(), `GET thread ${query.driverId}?date=${date}`).toBe(true);
    return comms;
  }

  test('DAY-01 threads?date= lists drivers with a message or an assignment that day: today has A (not B or C), tomorrow has A and B (B with no message, unread 0), never C', async ({
    page,
  }) => {
    const client = await api(page);

    const onToday = await client.threads(today);
    const ids = (list: { driverUserId: string }[]) => list.map((t) => t.driverUserId);
    expect(ids(onToday)).toContain(s.a);
    expect(ids(onToday)).not.toContain(s.b);
    expect(ids(onToday)).not.toContain(s.c);
    expect(onToday.find((t) => t.driverUserId === s.a)).toMatchObject({ lastMessageBody: `${MARKER} today #12`, unreadCount: 1 });

    const onTomorrow = await client.threads(tomorrow);
    expect(ids(onTomorrow)).toEqual(expect.arrayContaining([s.a, s.b]));
    expect(ids(onTomorrow)).not.toContain(s.c);
    expect(onTomorrow.find((t) => t.driverUserId === s.b)).toMatchObject({ lastMessageBody: null, lastMessageAt: null, unreadCount: 0 });
    expect(onTomorrow.find((t) => t.driverUserId === s.a)).toMatchObject({ lastMessageBody: null, unreadCount: 0 });

    const allTime = ids(await client.threads());
    expect(allTime, 'without a date the list is still drivers with messages').toContain(s.a);
    if (Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE Active = 1 AND DriverUserID_FK = N'${s.c}'`)) === 0) {
      expect(allTime, 'a driver who never had a message is not in the all-time list').not.toContain(s.c);
    }
  });

  test("DAY-02 the Today tab lists A but not B; tomorrow's tab lists A and B, puts date= in the URL and survives a reload", async ({ page }) => {
    await api(page);
    const comms = await openComms(page, { driverId: s.a });
    const strip = new DateStrip(page);

    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await expect(comms.driverItem(names.b)).toHaveCount(0);
    await expect(page.locator('.date-tab.active')).toHaveClass(/\bis-today\b/);

    const threads = comms.waitForThreads(tomorrow);
    await strip.select(isoToLocalDate(tomorrow));
    expect((await threads).ok()).toBe(true);
    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await expect(comms.driverItem(names.b)).toHaveCount(1);
    await expect(comms.driverItem(names.c)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`[?&]date=${tomorrow}(&|$)`));

    const reloaded = comms.waitForThreads(tomorrow);
    await page.reload();
    expect((await reloaded).ok(), 'the reload asks for the same day').toBe(true);
    await expect(page.locator('.date-tab.active')).not.toHaveClass(/\bis-today\b/);
    await expect(comms.driverItem(names.b)).toHaveCount(1);
    await snapshot(page, 'tomorrow-after-reload');
  });

  test('DAY-03 empty and preview labels name the day on another day and say "today" on today', async ({ page }) => {
    const client = await api(page);
    const day = dayLabel(tomorrow);

    let comms = await openComms(page, { driverId: s.a, date: tomorrow });
    await expect(comms.preview(names.b)).toHaveText(`No messages on ${day}`);
    await expect(comms.preview(names.a)).toHaveText(`No messages on ${day}`);
    await expect(comms.threadEmpty()).toHaveText(`No messages with this driver on ${day}.`);
    await expect(comms.assignmentsTitle()).toHaveText(`Assignments: ${day} and upcoming`);

    let emptyDay: string | null = null;
    for (const offset of [22, 29, 36, 43]) {
      const candidate = isoDate(offset);
      if ((await client.threads(candidate)).length === 0) {
        emptyDay = candidate;
        break;
      }
    }
    if (emptyDay) {
      comms = await openComms(page, { date: emptyDay });
      await expect(comms.listEmpty()).toHaveText(`No drivers have messages or assignments on ${dayLabel(emptyDay)}.`);
    } else {
      test.info().annotations.push({ type: 'empty-list-skipped', description: 'No day 3–6 weeks out was free of messages and assignments.' });
    }

    comms = await openComms(page, { driverId: s.c });
    await expect(comms.preview(names.c)).toHaveText('No messages today');
    await expect(comms.threadEmpty()).toHaveText('No messages with this driver today.');
    await expect(comms.assignmentsTitle()).toHaveText('Assignments: today and upcoming');
    await expect(comms.preview(names.a)).toHaveText(`${MARKER} today #12`);
  });

  test('DAY-04 New message finds a driver with nothing on the day, opens their thread and pins them at the top until the day changes', async ({ page }) => {
    await api(page);
    const comms = await openComms(page, { driverId: s.a });
    await expect(comms.driverItem(names.c)).toHaveCount(0);

    await comms.newMessageButton().click();
    const phone = querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = N'${s.c}'`)!;
    await comms.newMessageSearch().fill(phone);
    await expect(comms.newMessageOpen()).toBeDisabled();
    await comms.newMessageOption(phone).first().click();
    const thread = comms.waitForThread(s.c, today);
    await comms.newMessageOpen().click();
    expect((await thread).ok()).toBe(true);

    await expect(page).toHaveURL(new RegExp(`[?&]driverId=${s.c}(&|$)`));
    await expect(comms.threadEmpty()).toHaveText('No messages with this driver today.');
    await expect(comms.driverItems().first().locator('.driver-item-name')).toHaveText(names.c);
    await expect(comms.driverItems().first()).toHaveClass(/\bselected\b/);
    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await snapshot(page, 'pinned-driver');

    const threads = comms.waitForThreads(tomorrow);
    await new DateStrip(page).select(isoToLocalDate(tomorrow));
    expect((await threads).ok()).toBe(true);
    await expect(comms.driverItem(names.b)).toHaveCount(1);
    await expect(comms.driverItem(names.c)).toHaveCount(0);
  });

  test("DAY-05 A's thread on today carries tomorrow's assignment and hasEarlierMessages, and the info panel shows it", async ({ page }) => {
    const client = await api(page);

    const thread = await client.thread(s.a, today);
    expect(thread.hasEarlierMessages).toBe(true);
    const tomorrows = thread.assignments.find((a) => a.orderAssignmentId === s.assignmentA);
    expect(tomorrows).toMatchObject({ date: tomorrow, status: 'pending', startTime: expect.stringMatching(/^07:00/) });
    expect(
      thread.assignments.some((a) => a.orderAssignmentId === s.assignmentB),
      "another driver's assignment",
    ).toBe(false);
    expect(thread.messages.map((m) => m.messageId)).toEqual(todayIds(s.a));

    expect((await client.thread(s.a)).hasEarlierMessages, 'without a date there is nothing earlier').toBe(false);
    if (Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE Active = 1 AND DriverUserID_FK = N'${s.c}'`)) === 0) {
      expect((await client.thread(s.c, today)).hasEarlierMessages, 'a driver who never had a message').toBe(false);
    }
    expect((await client.thread(s.b, today)).assignments.map((a) => a.orderAssignmentId)).toContain(s.assignmentB);

    const comms = await openComms(page, { driverId: s.a });
    await expect(comms.assignmentsTitle()).toHaveText('Assignments: today and upcoming');
    await expect(comms.assignmentRows().filter({ hasText: label(tomorrows!.orderNumber ?? 'Order', dayLabel(tomorrow), '7:00 AM') })).toHaveCount(1);
    await snapshot(page, 'assignments-panel');
  });

  test('DAY-06 earlier pages back 30 at a time oldest-first by (Created, MessageId), then the rest with hasMore false; bad take/before are refused', async ({
    page,
  }) => {
    const client = await api(page);
    const expected = earlierThanToday(s.a);
    expect(expected.length, 'messages before today').toBeGreaterThanOrEqual(45);
    expect(expected.length).toBeLessThanOrEqual(60);

    const first = await client.earlier(s.a, { date: today });
    expect(first.status, first.text).toBe(200);
    const page1 = first.data as { messages: { messageId: number }[]; hasMore: boolean };
    expect(page1.messages.map((m) => m.messageId)).toEqual(expected.slice(-30));
    expect(page1.hasMore).toBe(true);

    const second = await client.earlier(s.a, { date: today, before: page1.messages[0].messageId });
    expect(second.status, second.text).toBe(200);
    const page2 = second.data as { messages: { messageId: number }[]; hasMore: boolean };
    expect(page2.messages.length).toBeGreaterThanOrEqual(15);
    expect(page2.messages.map((m) => m.messageId)).toEqual(expected.slice(0, -30));
    expect(page2.hasMore).toBe(false);
    const both = [...page2.messages, ...page1.messages].map((m) => m.messageId);
    expect(new Set(both).size, 'no message on both pages').toBe(both.length);

    const small = await client.earlier(s.a, { date: today, take: 5 });
    expect((small.data as { messages: { messageId: number }[] }).messages.map((m) => m.messageId)).toEqual(expected.slice(-5));

    const beforeLatest = await client.earlier(s.a, { before: s.latest, take: 20 });
    expect(beforeLatest.status, beforeLatest.text).toBe(200);
    const olderThanLatest = [...expected, ...todayIds(s.a)].filter((id) => id !== s.latest);
    expect((beforeLatest.data as { messages: { messageId: number }[] }).messages.map((m) => m.messageId)).toEqual(olderThanLatest.slice(-20));

    for (const take of [0, 51]) {
      const refused = await client.earlier(s.a, { date: today, take });
      expect(refused.status, `take=${take}: ${refused.text}`).toBe(400);
    }
    const zero = await client.earlier(s.a, { date: today, before: 0 });
    expect(zero.status, zero.text).toBe(400);

    const foreign = Number(
      querySingleValue(`SELECT TOP 1 MessageID FROM app.Messages WHERE Active = 1 AND DriverUserID_FK IS NOT NULL
      AND DriverUserID_FK <> N'${s.a}' ORDER BY MessageID DESC`),
    );
    expect(foreign, "another driver's message").toBeGreaterThan(0);
    const notHis = await client.earlier(s.a, { date: today, before: foreign });
    expect(notHis.status, notHis.text).toBe(404);

    const unknown = await client.earlier('00000000-0000-0000-0000-000000000000', { date: today });
    expect(unknown.status, unknown.text).toBe(404);
  });

  test('DAY-07 Load earlier and scrolling to the top add older pages above, keep the reading position, show the day divider and end at "Start of the conversation"', async ({
    page,
  }) => {
    await api(page);
    const expected = earlierThanToday(s.a);
    const todays = todayIds(s.a);
    const comms = await openComms(page, { driverId: s.a });

    await expect(comms.threadRows()).toHaveCount(todays.length);
    await expect(comms.loadEarlier()).toBeVisible();
    await expect(comms.dayDivider()).toHaveCount(0);
    await expect(comms.threadStart()).toHaveCount(0);
    const anchor = todays[0];
    const offsetBefore = await comms.offsetInThread(anchor);

    let earlier = comms.waitForEarlier(s.a);
    await comms.loadEarlier().evaluate((button) => (button as HTMLElement).click());
    expect((await earlier).ok()).toBe(true);
    await expect(comms.threadRows()).toHaveCount(todays.length + 30);
    expect(await comms.threadMessageIds()).toEqual([...expected.slice(-30), ...todays]);
    await expect(comms.dayDivider()).toHaveText('Today');
    await expect
      .poll(async () => Math.abs((await comms.offsetInThread(anchor)) - offsetBefore), {
        message: 'the first message of the day stays where it was',
      })
      .toBeLessThanOrEqual(40);
    const divider = await comms.dayDivider().boundingBox();
    const anchorBox = await comms.message(anchor).boundingBox();
    const lastEarlier = await comms.message(expected[expected.length - 1]).boundingBox();
    expect(divider!.y).toBeGreaterThan(lastEarlier!.y);
    expect(divider!.y).toBeLessThan(anchorBox!.y);
    await expect(comms.loadEarlier()).toBeVisible();
    await snapshot(page, 'first-earlier-page');

    earlier = comms.waitForEarlier(s.a);
    await comms.scrollToTop();
    const second = await earlier;
    expect(second.ok()).toBe(true);
    expect(new URL(second.url()).searchParams.get('before')).toBe(String(expected[expected.length - 30]));
    await expect(comms.threadRows()).toHaveCount(todays.length + expected.length);
    await expect(comms.threadStart()).toHaveText('Start of the conversation');
    await expect(comms.loadEarlier()).toHaveCount(0);
    const ids = await comms.threadMessageIds();
    expect(new Set(ids).size, 'no message twice').toBe(ids.length);
    expect(ids).toEqual([...expected, ...todays]);
    await expect(comms.dayDivider()).toHaveCount(1);
    await snapshot(page, 'start-of-conversation');
  });

  test('DAY-08 a thread opens scrolled to its newest message', async ({ page }) => {
    await api(page);
    const comms = await openComms(page, { driverId: s.a });
    await expect(comms.message(s.latest)).toBeVisible();

    const state = await comms.scrollState();
    expect(state.height, 'the day has more messages than fit, so the scroll matters').toBeGreaterThan(state.client);
    await expect
      .poll(async () => {
        const now = await comms.scrollState();
        return now.height - now.top - now.client;
      })
      .toBeLessThanOrEqual(2);
    expect(await comms.isInsideThreadView(s.latest)).toBe(true);
    expect(await comms.isInsideThreadView(todayIds(s.a)[0]), 'the first message of the day is scrolled out of view').toBe(false);
  });

  test('DAY-09 Back and Forward after picking a day switch the list and the strip between today and tomorrow without a reload', async ({ page }) => {
    await api(page);
    const comms = await openComms(page, { driverId: s.a });
    const strip = new DateStrip(page);
    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await expect(comms.driverItem(names.b)).toHaveCount(0);
    const loads: string[] = [];
    page.on('load', () => loads.push(page.url()));

    let threads = comms.waitForThreads(tomorrow);
    await strip.select(isoToLocalDate(tomorrow));
    expect((await threads).ok()).toBe(true);
    await expect(comms.driverItem(names.b)).toHaveCount(1);
    await expect(page).toHaveURL(new RegExp(`[?&]date=${tomorrow}(&|$)`));

    threads = comms.waitForThreads(today);
    await page.goBack();
    expect((await threads).ok(), 'Back asks for today again').toBe(true);
    await expect(page).not.toHaveURL(new RegExp(`[?&]date=${tomorrow}(&|$)`));
    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await expect(comms.driverItem(names.b)).toHaveCount(0);
    await expect(page.locator('.date-tab.active')).toHaveClass(/\bis-today\b/);

    threads = comms.waitForThreads(tomorrow);
    await page.goForward();
    expect((await threads).ok(), 'Forward asks for tomorrow again').toBe(true);
    await expect(page).toHaveURL(new RegExp(`[?&]date=${tomorrow}(&|$)`));
    await expect(comms.driverItem(names.a)).toHaveCount(1);
    await expect(comms.driverItem(names.b)).toHaveCount(1);
    await expect(page.locator('.date-tab.active')).not.toHaveClass(/\bis-today\b/);
    expect(loads, 'no full page load between the steps').toEqual([]);
    await snapshot(page, 'forward-to-tomorrow');
  });

  test('DAY-10 earlier with before= is strictly older by (Created, MessageId) even when Created has 3 or 7 milliseconds', async ({ page }) => {
    const client = await api(page);
    const at = (ms: string) => `DATEADD(HOUR, -50, ${TODAY_START_UTC}) + CAST('00:00:00.${ms}' AS datetime)`;
    const insert = (body: string, created: string) =>
      Number(
        querySingleValue(`SET NOCOUNT ON;
      INSERT app.Messages (Created, Updated, Active, DriverUserID_FK, MessageBody, PhoneNumber, SentAt, IsActioned, ActionedAt, SeenByDispatcherAt, Direction, MessageType, Channel)
      VALUES (${created}, ${created}, 1, N'${s.c}', N'${MARKER} ${body}', NULL, ${created}, 1, ${created}, ${created}, 10, 40, 10);
      SELECT SCOPE_IDENTITY();`),
      );
    const remove = () =>
      querySingleValue(`SET NOCOUNT ON; DELETE app.Messages WHERE DriverUserID_FK = N'${s.c}' AND MessageBody LIKE N'${MARKER} ms-%'; SELECT @@ROWCOUNT;`);
    try {
      const p0 = insert('ms-000 a', at('000'));
      const p3a = insert('ms-003 a', at('003'));
      const p3b = insert('ms-003 b', at('003'));
      const p7a = insert('ms-007 a', at('007'));
      const p7b = insert('ms-007 b', at('007'));
      const ids = async (before: number) => {
        const answer = await client.earlier(s.c, { before, take: 50 });
        expect(answer.status, answer.text).toBe(200);
        return (answer.data as { messages: { messageId: number }[] }).messages.map((m) => m.messageId);
      };

      expect.soft(await ids(p7b), 'before the second .007 message').toEqual([p0, p3a, p3b, p7a]);
      expect.soft(await ids(p7a), 'before the first .007 message').toEqual([p0, p3a, p3b]);
      expect.soft(await ids(p3b), 'before the second .003 message').toEqual([p0, p3a]);
      expect.soft(await ids(p3a), 'before the first .003 message').toEqual([p0]);
    } finally {
      remove();
    }
  });
});
