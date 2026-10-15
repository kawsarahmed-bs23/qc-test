import { test, expect } from '../../fixtures/test';
import { env } from '../../config/environment';
import { canSeedLocalDb, runSeedScript } from '../../fixtures/localDb';
import { CommsPage, PlanVsLivePage, TicketActivityPage, formatAppDateTime } from '../../pages/AppPages';

const BROWSER_ZONE = 'Asia/Dhaka';
const SEEDED_DAY = new Date(2026, 9, 5);
const PLAN_CAPTURED_UTC = new Date('2026-10-05T05:00:58Z');

interface SeededMessage {
  messageId: number;
  driverUserId: string;
  createdUtc: Date;
}

function parseSeededMessage(output: string): SeededMessage {
  const match = output.match(/SEED message=(\d+);driver=([^;\s]+);createdUtc=(\S+)/);
  if (!match) {
    throw new Error(`The message seed did not report its row:\n${output}`);
  }
  return { messageId: Number(match[1]), driverUserId: match[2], createdUtc: new Date(match[3]) };
}

test.describe('App time zone (QC-654)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed a message and a midnight plan.');
  test.skip(!env.appTimeZone, "APP_TIME_ZONE (the host's app time zone) is not set for this environment.");
  test.use({ timezoneId: BROWSER_ZONE });

  const appZone = env.appTimeZone!;
  let seeded: SeededMessage;

  test.beforeAll(() => {
    seeded = parseSeededMessage(runSeedScript('app-time-zone.apply.sql'));
    runSeedScript('plan-vs-live.apply.sql');
  });

  test.afterAll(() => {
    runSeedScript('app-time-zone.remove.sql');
    runSeedScript('plan-vs-live.remove.sql');
  });

  test("TZ-01 Communications shows the API's app-time-zone time for a message, not the browser's", async ({ page }) => {
    const comms = new CommsPage(page);
    await comms.open(seeded.driverUserId);

    const expected = formatAppDateTime(seeded.createdUtc, appZone);
    expect(expected, 'the probe instant must read differently in the two zones').not.toBe(
      formatAppDateTime(seeded.createdUtc, BROWSER_ZONE),
    );

    await expect(comms.message(seeded.messageId)).toBeVisible({ timeout: 30_000 });
    await expect(comms.messageTime(seeded.messageId)).toHaveText(expected);
  });

  test("TZ-02 Plan vs Live shows the API's app-time-zone time for when the midnight plan was captured", async ({ page }) => {
    const board = new PlanVsLivePage(page);
    const comparison = page.waitForResponse((r) => r.url().includes('/schedule-comparison?') && r.url().includes('date=2026-10-05'));
    await board.open(SEEDED_DAY);

    const body = await (await comparison).json();
    expect(body?.data?.hasSnapshot, 'the API must see the seeded midnight plan').toBe(true);

    const expected = formatAppDateTime(PLAN_CAPTURED_UTC, appZone);
    expect(expected).not.toBe(formatAppDateTime(PLAN_CAPTURED_UTC, BROWSER_ZONE));
    expect(body?.data?.snapshotCapturedAt, 'the API formats the capture time').toBe(expected);

    await expect(board.capturedAt()).toContainText(`captured ${expected}`);
  });

  test('TZ-03 every QC-654 date-time the API sends for display uses the common MM/dd/yyyy hh:mmtt format', async ({ page }) => {
    await page.goto('/#/dashboard/dispatch-dashboard');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();

    const found = await page.evaluate(
      async ({ driverUserId, day }) => {
        const api = 'https://localhost:7026/api/dispatch';
        const headers = { Authorization: `Bearer ${localStorage.getItem('accessToken')}`, 'Content-Type': 'application/json' };
        const get = async (path: string) => (await (await fetch(`${api}${path}`, { headers })).json())?.data;
        const values: Record<string, unknown> = {};

        const thread = await get(`/messages/threads/${encodeURIComponent(driverUserId)}?date=${day}`);
        for (const m of thread?.messages ?? []) {
          values[`thread.messages[${m.messageId}].created`] = m.created;
          for (const key of ['deliveredAt', 'seenByDispatcherAt', 'seenByDriverAt']) {
            if (m[key] != null) values[`thread.messages[${m.messageId}].${key}`] = m[key];
          }
        }
        for (const s of (await get(`/messages/threads?date=${day}`)) ?? []) {
          if (s.lastMessageAt != null) values[`threads[${s.driverUserId}].lastMessageAt`] = s.lastMessageAt;
        }
        for (const q of (await get('/messages/queue')) ?? []) values[`queue[${q.messageId}].created`] = q.created;

        const log = await get(`/tickets?date=${day}`);
        for (const r of log?.rows ?? []) {
          if (r.lastTicketAt != null) values[`tickets.rows[${r.rowKey}].lastTicketAt`] = r.lastTicketAt;
          for (const t of r.tickets ?? []) {
            if (t.startedAt != null) values[`tickets.trip[${t.tripId}].startedAt`] = t.startedAt;
            if (t.completedAt != null) values[`tickets.trip[${t.tripId}].completedAt`] = t.completedAt;
          }
        }

        const comparison = await get(`/schedule-comparison?date=${day}`);
        values['scheduleComparison.snapshotCapturedAt'] = comparison?.snapshotCapturedAt;

        const dashboard = (await (await fetch(`${api}/dashboard`, { method: 'POST', headers, body: JSON.stringify({ searchDate: day }) })).json())?.data;
        values['dashboard.asOf'] = dashboard?.asOf;

        return values;
      },
      { driverUserId: seeded.driverUserId, day: '2026-10-05' },
    );

    const commonFormat = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/;
    const wrong = Object.entries(found).filter(([, value]) => typeof value !== 'string' || !commonFormat.test(value));

    expect(Object.keys(found).length, 'the seeded day must return date-times to check').toBeGreaterThan(5);
    expect(found['thread.messages[' + seeded.messageId + '].created']).toBe(formatAppDateTime(seeded.createdUtc, appZone));
    expect(wrong, `fields not in MM/dd/yyyy hh:mmtt:\n${JSON.stringify(wrong, null, 1)}`).toEqual([]);
    test.info().annotations.push({ type: 'checked', description: JSON.stringify(found) });
  });

  test("TZ-04 Ticket Activity prints the API's last-ticket and haul times as sent", async ({ page }) => {
    const tickets = new TicketActivityPage(page);
    const response = page.waitForResponse((r) => r.url().includes('/api/dispatch/tickets?') && r.url().includes('date=2026-10-05'));
    await tickets.open(SEEDED_DAY);
    const rows: { lastTicketAt: string | null; tickets: { startedAt: string | null; completedAt: string | null }[] }[] =
      (await (await response).json())?.data?.rows ?? [];

    const withTickets = rows.filter((r) => r.lastTicketAt);
    test.skip(withTickets.length === 0, 'No hauled tickets on the seeded day in the local data.');

    await expect(tickets.lastTicketTimes()).toHaveText(withTickets.map((r) => r.lastTicketAt!));

    const firstCard = tickets.cards.filter({ has: page.locator('.last-time') }).first();
    await tickets.expand(firstCard);
    const expectedHauls = withTickets[0].tickets.map((t) => `${t.startedAt ?? '—'} – ${t.completedAt ?? '—'}`);
    await expect(tickets.haulTimes(firstCard)).toHaveText(expectedHauls);
    await expect(page.getByText('Invalid date')).toHaveCount(0);
  });
});
