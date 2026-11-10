import type { Locator, Page } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue } from '@utils/localDb';
import { CommsHostAdmin, QC804_ADMIN_STATE } from '@pages/comms-send-gate.page';
import { CommsDayApi, type CommsDayPage, dayLabel } from '@pages/comms-day.page';

const APP_ZONE = 'America/Chicago';
const APP_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)`;
const APP_DAY_OF = (column: string) =>
  `CONVERT(varchar(10), CAST(CAST(${column} AS datetime) AT TIME ZONE 'UTC' AT TIME ZONE 'Central Standard Time' AS date), 23)`;
const WIDTHS = [1440, 1024, 860];
const ADMIN_STATE = QC804_ADMIN_STATE.replace(/\.json$/, '.qc889.json');

interface TextFit {
  text: string;
  whiteSpace: string;
  textOverflow: string;
  scrollWidth: number;
  clientWidth: number;
  right: number;
  boxRight: number;
}

function fit(locator: Locator): Promise<TextFit> {
  return locator.evaluate((el) => {
    const style = getComputedStyle(el);
    const box = el.parentElement!.getBoundingClientRect();
    return {
      text: (el as HTMLElement).innerText.trim(),
      whiteSpace: style.whiteSpace,
      textOverflow: style.textOverflow,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      right: el.getBoundingClientRect().right,
      boxRight: box.right - parseFloat(getComputedStyle(el.parentElement!).paddingRight),
    };
  });
}

async function expectWhole(message: Locator, sentence: string): Promise<void> {
  await expect(message).toBeVisible();
  await expect(message).toHaveText(sentence);
  await expect(message).toHaveCSS('white-space', 'normal');
  await expect(message).not.toHaveCSS('text-overflow', 'ellipsis');
  const measured = await fit(message);
  expect(measured.text, 'the whole sentence is rendered').toBe(sentence);
  expect(measured.scrollWidth, 'nothing is cut off inside the message').toBeLessThanOrEqual(measured.clientWidth);
  expect(measured.right, 'the message stays inside its box').toBeLessThanOrEqual(measured.boxRight + 1);
}

async function screenshot(page: Page, name: string): Promise<void> {
  const file = test.info().outputPath(`${name}.png`);
  await page.screenshot({ path: file });
  await test.info().attach(name, { path: file, contentType: 'image/png' });
}

test.describe('Comms empty-state messages are shown in full, not truncated (QC-889)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to find a day with conversations.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the threads API cannot be asked which days are empty.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.use({ storageState: ADMIN_STATE, timezoneId: env.appTimeZone ?? APP_ZONE });

  test.beforeAll(async ({ browser }) => {
    await CommsHostAdmin.signIn(browser, ADMIN_STATE);
  });

  test.afterAll(() => {
    CommsHostAdmin.remove(ADMIN_STATE);
  });

  async function api(page: Page): Promise<CommsDayApi> {
    await page.goto('/');
    const client = new CommsDayApi(page, env.appApiUrl!);
    await client.ready();
    return client;
  }

  async function emptyDay(client: CommsDayApi): Promise<string> {
    for (const offset of [64, 71, 78, 85, 92, 99]) {
      const candidate = querySingleValue(`SELECT CONVERT(varchar(10), DATEADD(DAY, ${offset}, ${APP_TODAY}), 23)`) ?? '';
      if ((await client.threads(candidate)).length === 0) return candidate;
    }
    test.skip(true, 'No day 9â€“14 weeks out was free of messages and assignments.');
    return '';
  }

  async function openDay(commsDayPage: CommsDayPage, query: { date: string; driverId?: string }): Promise<void> {
    const threads = commsDayPage.waitForThreads(query.date);
    const thread = query.driverId ? commsDayPage.waitForThread(query.driverId, query.date) : null;
    await commsDayPage.open(query);
    expect((await threads).ok(), `GET threads?date=${query.date}`).toBe(true);
    if (thread) expect((await thread).ok(), `GET thread ${query.driverId}?date=${query.date}`).toBe(true);
  }

  test('CEMPTY-01 on a day with no conversations the driver list says "No drivers have messages or assignments on â€¦." in full at 1440, 1024 and 860 px', async ({
    page,
    commsDayPage,
  }) => {
    const client = await api(page);
    const day = await emptyDay(client);
    const sentence = `No drivers have messages or assignments on ${dayLabel(day)}.`;

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await openDay(commsDayPage, { date: day });
      await expect(commsDayPage.driverItems()).toHaveCount(0);
      await expectWhole(commsDayPage.listEmpty(), sentence);
      await screenshot(page, `list-empty-${width}`);
    }
  });

  test('CEMPTY-02 a driver opened on a day with no messages shows "No messages with this driver on â€¦." in full at 1440, 1024 and 860 px', async ({
    page,
    commsDayPage,
  }) => {
    const client = await api(page);
    const day = await emptyDay(client);
    const driverId = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE u.IsActive = 1
      AND u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName = 'Driver')
      ORDER BY (SELECT COUNT(*) FROM app.Messages m WHERE m.DriverUserID_FK = u.Id AND m.Active = 1) DESC, u.Id`);
    test.skip(!driverId, 'No active Driver user to open a thread for.');
    expect((await client.thread(driverId!, day)).messages, 'the driver has no messages on the empty day').toEqual([]);
    const sentence = `No messages with this driver on ${dayLabel(day)}.`;

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await openDay(commsDayPage, { date: day, driverId: driverId! });
      await expectWhole(commsDayPage.threadEmpty(), sentence);
      await screenshot(page, `thread-empty-${width}`);
    }
  });

  test('CEMPTY-03 on a day with conversations a long message preview in the driver list is still one line ending in an ellipsis', async ({
    page,
    commsDayPage,
  }) => {
    const client = await api(page);
    const days = (
      querySingleValue(`SELECT STRING_AGG(d, ',') WITHIN GROUP (ORDER BY d DESC) FROM (
        SELECT DISTINCT ${APP_DAY_OF('m.Created')} AS d FROM app.Messages m
        WHERE m.Active = 1 AND m.DriverUserID_FK IS NOT NULL AND LEN(m.MessageBody) >= 40) x`) ?? ''
    )
      .split(',')
      .filter(Boolean);

    let found: { day: string; name: string; body: string } | null = null;
    for (const day of days.slice(0, 15)) {
      const thread = (await client.threads(day)).find((t) => (t.lastMessageBody ?? '').length >= 40 && t.driverName);
      if (thread) {
        found = { day, name: thread.driverName!, body: thread.lastMessageBody! };
        break;
      }
    }
    test.skip(!found, 'No day in the local data has a driver whose last message of the day is 40+ characters.');
    test.info().annotations.push({ type: 'conversation-day', description: `${found!.day} (${found!.name})` });

    await openDay(commsDayPage, { date: found!.day });
    const preview = commsDayPage.preview(found!.name);
    await expect(preview).toBeVisible();
    await expect(preview).toHaveCSS('white-space', 'nowrap');
    await expect(preview).toHaveCSS('text-overflow', 'ellipsis');
    await expect(preview).toHaveCSS('overflow', 'hidden');
    await expect(preview).toHaveCSS('max-width', '170px');
    const measured = await fit(preview);
    expect(measured.scrollWidth, 'the long preview is cut to one line').toBeGreaterThan(measured.clientWidth);
    await screenshot(page, 'conversation-preview-1440');
  });
});
