import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { CommsPage } from '@pages/app.page';
import { CommsHostAdmin, QC804_ADMIN_STATE } from '@pages/comms-send-gate.page';
import { AI_CLASSIFICATION, ASSIGNMENT_STATUS, assignmentDateLabel, MessageLinkApi, MessageLinkPanel, TRIP_NOTE_STATUS } from '@pages/message-link.page';

const MARKER = 'E2E-QC805';
const APP_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)`;
const DRIVER_ROLE = `u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName LIKE '%Driver%')`;

interface Seeded {
  driver: string;
  order: number;
  today: number;
  tomorrow: number;
  yesterday: number;
  noShow: number;
  m: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number>;
}

function pickDriver(): string {
  const driver = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${DRIVER_ROLE} AND u.IsActive = 1 AND ISNULL(u.PhoneNumber, '') <> ''
    AND EXISTS (SELECT 1 FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK JOIN app.Jobs j ON j.JobID = o.JobID_FK
      WHERE a.DriverUserID_FK = u.Id AND a.Active = 1 AND o.Active = 1 AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL AND j.IsNightShift = 0)
    AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id AND a.Active = 1
      AND a.AssignmentDate >= DATEADD(DAY, -1, ${APP_TODAY}) AND ISNULL(a.Notes, '') <> N'${MARKER}')
    ORDER BY u.Id DESC`);
  if (!driver) throw new Error('QC-805 needs an active driver with a phone, a day-shift truck assignment to copy and no live work from yesterday on.');
  return driver;
}

function seed(driver: string): Seeded {
  const output = runSeedScript('message-link-qc805.apply.sql', { DriverId: driver });
  const line = output.split(/\r?\n/).find((l) => l.includes('SEED order='));
  if (!line) {
    runSeedScript('message-link-qc805.remove.sql');
    throw new Error(`The QC-805 seed did not report its rows:\n${output}`);
  }
  const values = Object.fromEntries(
    line
      .trim()
      .replace(/^SEED /, '')
      .split(';')
      .map((p) => p.split('='))
      .map(([k, v]) => [k, Number(v)]),
  );
  return {
    driver,
    order: values.order,
    today: values.today,
    tomorrow: values.tomorrow,
    yesterday: values.yesterday,
    noShow: values.noshow,
    m: { 1: values.m1, 2: values.m2, 3: values.m3, 4: values.m4, 5: values.m5, 6: values.m6, 7: values.m7, 8: values.m8 },
  };
}

function num(query: string): number {
  return Number(querySingleValue(query));
}

function linkedAssignment(messageId: number): number | null {
  const value = querySingleValue(`SELECT OrderAssignmentID_FK FROM app.Messages WHERE MessageID = ${messageId}`);
  return value === null ? null : Number(value);
}

function assignmentStatus(assignmentId: number): number {
  return num(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignmentId}`);
}

function historyCount(assignmentId: number, like: string): number {
  return num(`SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignmentId}
    AND OrderAssignmentHistoryData LIKE '${like.replace(/'/g, "''")}'`);
}

function tripNotes(assignmentId: number, messageId: number, statusType?: number): number {
  return num(`SELECT COUNT(*) FROM app.TripNotes t WHERE t.OrderAssignmentID_FK = ${assignmentId}
    AND t.NoteText = (SELECT MessageBody FROM app.Messages WHERE MessageID = ${messageId})${statusType ? ` AND t.StatusType = ${statusType}` : ''}`);
}

function actioned(messageId: number): { isActioned: number; classification: number | null } {
  const classification = querySingleValue(`SELECT AiClassification FROM app.Messages WHERE MessageID = ${messageId}`);
  return {
    isActioned: num(`SELECT CAST(IsActioned AS int) FROM app.Messages WHERE MessageID = ${messageId}`),
    classification: classification === null ? null : Number(classification),
  };
}

function isoDate(offsetDays: number): string {
  return querySingleValue(`SELECT CONVERT(varchar(10), DATEADD(DAY, ${offsetDays}, ${APP_TODAY}), 23)`) ?? '';
}

function label(...parts: string[]): RegExp {
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  return new RegExp(escaped.join('\\s+·\\s+'));
}

async function snapshot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('Comms: link a driver message to an assignment and offer only the fitting responses (QC-805)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed an order, assignments and messages.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the thread, link and action API cannot be called directly.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.use({ storageState: QC804_ADMIN_STATE });

  let s: Seeded;
  let today: string;
  let tomorrow: string;
  let orderNumber: string;

  test.beforeAll(async ({ browser }) => {
    await CommsHostAdmin.signIn(browser);
    s = seed(pickDriver());
    today = isoDate(0);
    tomorrow = isoDate(1);
  });

  test.afterAll(() => {
    try {
      runSeedScript('message-link-qc805.remove.sql');
    } finally {
      CommsHostAdmin.remove();
    }
  });

  async function openThread(page: Page): Promise<{ panel: MessageLinkPanel; api: MessageLinkApi }> {
    const thread = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(`/messages/threads/${s.driver}`), {
      timeout: 30_000,
    });
    await new CommsPage(page).open(s.driver);
    expect((await thread).ok(), 'GET thread').toBe(true);
    const api = new MessageLinkApi(page, env.appApiUrl!);
    await api.ready();
    return { panel: new MessageLinkPanel(page), api };
  }

  test('LINK-01 an unlinked driver message offers only Noted, in the API and on its bubble', async ({ page }) => {
    const { panel, api } = await openThread(page);

    const message = await api.message(s.driver, s.m[1]);
    expect(message.orderAssignmentId).toBeNull();
    expect(message.availableActions).toEqual(['noted']);

    await expect(panel.unlinkedTag(s.m[1])).toHaveText('Not linked to a job');
    await expect(panel.linkedTag(s.m[1])).toHaveCount(0);
    await expect(panel.threadActions(s.m[1])).toHaveCount(1);
    expect(await panel.actionsOf(panel.threadActions(s.m[1]))).toEqual(['noted']);
    await expect(panel.threadAction(s.m[1], 'noted')).toHaveText('Noted');
    await snapshot(page, 'unlinked-message');
  });

  test("LINK-02 the thread lists today's and tomorrow's open assignments (not yesterday's) by date and start, and the link menu offers all three", async ({
    page,
  }) => {
    const { panel, api } = await openThread(page);

    const { openAssignments } = await api.thread(s.driver);
    expect(openAssignments.map((a) => a.orderAssignmentId)).toEqual([s.noShow, s.today, s.tomorrow]);
    expect(openAssignments.map((a) => a.date)).toEqual([today, today, tomorrow]);
    expect(openAssignments.map((a) => a.status)).toEqual(['accepted', 'accepted', 'pending']);
    expect(openAssignments.map((a) => a.startTime)).toEqual([
      expect.stringMatching(/^00:00/),
      expect.stringMatching(/^23:59/),
      expect.stringMatching(/^06:30/),
    ]);
    expect(openAssignments[0].orderNumber).toBeTruthy();
    expect(new Set(openAssignments.map((a) => a.orderNumber)).size).toBe(1);
    orderNumber = openAssignments[0].orderNumber!;

    await panel.linkMenuButton(s.m[1]).click();
    await expect(panel.menuItems()).toHaveCount(3);
    await expect(panel.menuItems().nth(0)).toHaveText(label(orderNumber, assignmentDateLabel(today), '12:00 AM'));
    await expect(panel.menuItems().nth(1)).toHaveText(label(orderNumber, assignmentDateLabel(today), '11:59 PM'));
    await expect(panel.menuItems().nth(2)).toHaveText(label(orderNumber, assignmentDateLabel(tomorrow), '6:30 AM'));
    await snapshot(page, 'link-menu');
    await page.keyboard.press('Escape');
  });

  test("LINK-03 linking the message to tomorrow's assignment through the menu stores the link, writes history and offers Decline + Noted", async ({ page }) => {
    const { panel, api } = await openThread(page);

    await panel.linkMenuButton(s.m[1]).click();
    const linked = panel.waitForLink(s.m[1]);
    await panel.menuItem(assignmentDateLabel(tomorrow)).click();
    await linked;

    await expect.poll(() => linkedAssignment(s.m[1])).toBe(s.tomorrow);
    expect(historyCount(s.tomorrow, `Driver message #${s.m[1]} linked to this assignment: ${MARKER}%`)).toBe(1);

    await expect(panel.linkedTag(s.m[1])).toHaveText(label(orderNumber, assignmentDateLabel(tomorrow), '6:30 AM'));
    await expect(panel.unlinkedTag(s.m[1])).toHaveCount(0);
    await expect(panel.threadActions(s.m[1])).toHaveCount(2);
    expect(await panel.actionsOf(panel.threadActions(s.m[1]))).toEqual(['cant-make-it', 'noted']);
    expect(await panel.labelsOf(panel.threadActions(s.m[1]))).toEqual(['Decline', 'Noted']);

    expect(await api.message(s.driver, s.m[1])).toMatchObject({
      orderAssignmentId: s.tomorrow,
      assignmentStatus: 'pending',
      assignmentDate: tomorrow,
      availableActions: ['cant-make-it', 'noted'],
    });
    await snapshot(page, 'linked-tomorrow');
  });

  test("LINK-04 a message linked to today's assignment can be moved to tomorrow's and unlinked, with a history row each way", async ({ page }) => {
    const { panel } = await openThread(page);

    await panel.linkMenuButton(s.m[2]).click();
    let request = panel.waitForLink(s.m[2]);
    await panel.menuItem(label(assignmentDateLabel(today), '11:59 PM')).click();
    await request;
    await expect.poll(() => linkedAssignment(s.m[2])).toBe(s.today);
    expect(historyCount(s.today, `Driver message #${s.m[2]} linked to this assignment: ${MARKER}%`)).toBe(1);
    await expect(panel.linkedTag(s.m[2])).toHaveText(label(orderNumber, assignmentDateLabel(today), '11:59 PM'));

    await panel.changeButton(s.m[2]).click();
    await expect(panel.menuItems()).toHaveCount(3);
    await expect(panel.menuItems().nth(0)).toHaveText(label(`Move to ${orderNumber}`, assignmentDateLabel(today), '12:00 AM'));
    await expect(panel.menuItems().nth(1)).toHaveText(label(`Move to ${orderNumber}`, assignmentDateLabel(tomorrow), '6:30 AM'));
    await expect(panel.menuItems().nth(2)).toHaveText('Unlink');
    request = panel.waitForLink(s.m[2]);
    await panel.menuItems().nth(1).click();
    await request;
    await expect.poll(() => linkedAssignment(s.m[2])).toBe(s.tomorrow);
    expect(historyCount(s.today, `Driver message #${s.m[2]} moved to another assignment.`)).toBe(1);
    expect(historyCount(s.tomorrow, `Driver message #${s.m[2]} linked to this assignment: ${MARKER}%`)).toBe(1);
    await expect(panel.linkedTag(s.m[2])).toHaveText(label(orderNumber, assignmentDateLabel(tomorrow), '6:30 AM'));

    await panel.changeButton(s.m[2]).click();
    request = panel.waitForLink(s.m[2]);
    await panel.menuItem('Unlink').click();
    await request;
    await expect.poll(() => linkedAssignment(s.m[2])).toBeNull();
    expect(historyCount(s.tomorrow, `Driver message #${s.m[2]} unlinked from this assignment.`)).toBe(1);
    await expect(panel.unlinkedTag(s.m[2])).toHaveText('Not linked to a job');
    expect(await panel.actionsOf(panel.threadActions(s.m[2]))).toEqual(['noted']);
    await snapshot(page, 'moved-and-unlinked');
  });

  test("LINK-05 Decline rejects tomorrow's assignment, writes history, no trip note, keeps its Notes, and frees the truck on the board", async ({ page }) => {
    const { panel, api } = await openThread(page);
    expect(linkedAssignment(s.m[1])).toBe(s.tomorrow);
    expect(assignmentStatus(s.tomorrow)).toBe(ASSIGNMENT_STATUS.Pending);
    const notesBefore = querySingleValue(`SELECT Notes FROM app.OrderAssignments WHERE OrderAssignmentID = ${s.tomorrow}`);
    expect(await api.unassigned(tomorrow, s.order), 'one truck needed and one assigned before').toEqual([]);

    const action = panel.waitForAction(s.m[1]);
    await panel.threadAction(s.m[1], 'cant-make-it').click();
    expect((await action).status(), 'PUT action cant-make-it').toBe(200);

    await expect.poll(() => assignmentStatus(s.tomorrow)).toBe(ASSIGNMENT_STATUS.Rejected);
    expect(historyCount(s.tomorrow, 'Status changed from Pending to Rejected.')).toBe(1);
    expect(historyCount(s.tomorrow, `Driver declined (message #${s.m[1]}): ${MARKER}%`)).toBe(1);
    expect(actioned(s.m[1])).toEqual({ isActioned: 1, classification: AI_CLASSIFICATION.CantMakeIt });
    expect(tripNotes(s.tomorrow, s.m[1])).toBe(0);
    expect(querySingleValue(`SELECT Notes FROM app.OrderAssignments WHERE OrderAssignmentID = ${s.tomorrow}`)).toBe(notesBefore);

    expect(await api.unassigned(tomorrow, s.order)).toEqual([expect.objectContaining({ orderId: s.order, date: tomorrow, trucksNeeded: 1, assignedCount: 0 })]);
    expect(
      (await api.thread(s.driver)).openAssignments.map((a) => a.orderAssignmentId),
      'a rejected assignment is no longer open',
    ).toEqual([s.noShow, s.today]);
    await expect(panel.threadActions(s.m[1])).toHaveCount(0);
    await snapshot(page, 'decline');
  });

  test("LINK-06 a message on today's Accepted assignment whose start has not passed offers Mark Late, Flag Issue, Decline, Noted; Mark Late writes a Late trip note only", async ({
    page,
  }) => {
    const { panel, api } = await openThread(page);

    expect((await api.message(s.driver, s.m[3])).availableActions).toEqual(['late', 'issue', 'cant-make-it', 'noted']);
    await expect(panel.linkedTag(s.m[3])).toHaveText(label(orderNumber, assignmentDateLabel(today), '11:59 PM'));
    expect(await panel.labelsOf(panel.threadActions(s.m[3]))).toEqual(['Mark Late', 'Flag Issue', 'Decline', 'Noted']);
    expect(await panel.actionsOf(panel.threadActions(s.m[3]))).toEqual(['late', 'issue', 'cant-make-it', 'noted']);

    const action = panel.waitForAction(s.m[3]);
    await panel.threadAction(s.m[3], 'late').click();
    expect((await action).status(), 'PUT action late').toBe(200);

    await expect.poll(() => tripNotes(s.today, s.m[3], TRIP_NOTE_STATUS.Late)).toBe(1);
    expect(assignmentStatus(s.today)).toBe(ASSIGNMENT_STATUS.Accepted);
    expect(actioned(s.m[3]).isActioned).toBe(1);
  });

  test("LINK-07 a message on today's Accepted assignment whose start has passed adds No Show, which sets NoShow and writes a NoShow trip note; yesterday's offers Noted only", async ({
    page,
  }) => {
    const { panel, api } = await openThread(page);

    expect(await api.message(s.driver, s.m[8])).toMatchObject({
      orderAssignmentId: s.noShow,
      assignmentStatus: 'accepted',
      assignmentDate: today,
      availableActions: ['late', 'issue', 'cant-make-it', 'no-show', 'noted'],
    });
    await expect(panel.linkedTag(s.m[8])).toHaveText(label(orderNumber, assignmentDateLabel(today), '12:00 AM'));
    expect(await panel.labelsOf(panel.threadActions(s.m[8]))).toEqual(['Mark Late', 'Flag Issue', 'Decline', 'No Show', 'Noted']);

    expect(await api.message(s.driver, s.m[4])).toMatchObject({ orderAssignmentId: s.yesterday, availableActions: ['noted'] });
    expect(await panel.actionsOf(panel.threadActions(s.m[4]))).toEqual(['noted']);
    const pastNoShow = await api.action(s.m[4], 'no-show');
    expect(pastNoShow.status, pastNoShow.text).toBe(400);
    expect(pastNoShow.text).toContain('That action does not fit this message');
    expect(assignmentStatus(s.yesterday)).toBe(ASSIGNMENT_STATUS.Accepted);
    expect(actioned(s.m[4])).toEqual({ isActioned: 0, classification: null });

    const action = panel.waitForAction(s.m[8]);
    await panel.threadAction(s.m[8], 'no-show').click();
    const response = await action;
    expect(response.status(), `PUT action no-show answered ${await response.text()}`).toBe(200);

    await expect.poll(() => assignmentStatus(s.noShow)).toBe(ASSIGNMENT_STATUS.NoShow);
    expect(historyCount(s.noShow, 'Status changed from Accepted to No Show.')).toBe(1);
    expect(tripNotes(s.noShow, s.m[8], TRIP_NOTE_STATUS.NoShow)).toBe(1);
    expect(actioned(s.m[8]).isActioned).toBe(1);
    await expect(panel.threadActions(s.m[8])).toHaveCount(0);
  });

  test('LINK-08 Noted on a linked message marks it actioned and writes no trip note', async ({ page }) => {
    const { panel } = await openThread(page);
    expect(linkedAssignment(s.m[5])).toBe(s.today);

    const action = panel.waitForAction(s.m[5]);
    await panel.threadAction(s.m[5], 'noted').click();
    expect((await action).status(), 'PUT action noted').toBe(200);

    await expect.poll(() => actioned(s.m[5])).toEqual({ isActioned: 1, classification: AI_CLASSIFICATION.Noted });
    expect(tripNotes(s.today, s.m[5])).toBe(0);
    expect(assignmentStatus(s.today)).toBe(ASSIGNMENT_STATUS.Accepted);
  });

  test("LINK-09 the API refuses an action that does not fit, a link to another driver's or a past assignment, and a body id that differs from the route", async ({
    page,
  }) => {
    const { api } = await openThread(page);
    const otherDriversAssignment = num(`SELECT TOP 1 a.OrderAssignmentID FROM app.OrderAssignments a
      WHERE a.Active = 1 AND a.DriverUserID_FK IS NOT NULL AND a.DriverUserID_FK <> '${s.driver}'
      ORDER BY CASE WHEN a.AssignmentDate >= ${APP_TODAY} AND a.OrderAssignmentStatusID_FK IN (1, 2, 4) THEN 0 ELSE 1 END, a.OrderAssignmentID DESC`);
    expect(otherDriversAssignment).toBeGreaterThan(0);

    const late = await api.action(s.m[6], 'late');
    expect(late.status, late.text).toBe(400);
    expect(late.text).toContain('That action does not fit this message');

    const foreign = await api.link(s.m[6], otherDriversAssignment);
    expect(foreign.status, foreign.text).toBe(400);
    expect(foreign.text).toContain("Choose one of this driver's open assignments");

    const past = await api.link(s.m[6], s.yesterday);
    expect(past.status, past.text).toBe(400);
    expect(past.text).toContain("Choose one of this driver's open assignments");

    const same = await api.link(s.m[7], s.today);
    expect(same.status, same.text).toBe(400);
    expect(same.text).toContain('already linked');

    const linkMismatch = await api.link(s.m[6], s.today, s.m[7]);
    expect(linkMismatch.status, linkMismatch.text).toBe(400);
    expect(linkMismatch.text).toContain('The messageId in the body must match the message in the URL.');

    const actionMismatch = await api.action(s.m[6], 'noted', s.m[7]);
    expect(actionMismatch.status, actionMismatch.text).toBe(400);
    expect(actionMismatch.text).toContain('The messageId in the body must match the message in the URL.');

    expect(linkedAssignment(s.m[6])).toBeNull();
    expect(linkedAssignment(s.m[7])).toBe(s.today);
    expect(actioned(s.m[6])).toEqual({ isActioned: 0, classification: null });
    expect(actioned(s.m[7])).toEqual({ isActioned: 0, classification: null });
  });

  test('LINK-10 the Incoming Queue offers only Noted for an unlinked item and the fitting buttons for a linked one', async ({ page }) => {
    const { panel, api } = await openThread(page);

    const queue = await api.queue();
    expect(queue.find((q) => q.messageId === s.m[6])?.availableActions).toEqual(['noted']);
    expect(queue.find((q) => q.messageId === s.m[7])?.availableActions).toEqual(['late', 'issue', 'cant-make-it', 'noted']);
    expect(
      queue.find((q) => q.messageId === s.m[3]),
      'an actioned message leaves the queue',
    ).toBeUndefined();

    await panel.queueTab().click();
    await expect(panel.queueActions(s.m[6])).toHaveCount(1);
    expect(await panel.actionsOf(panel.queueActions(s.m[6]))).toEqual(['noted']);
    await expect(panel.queueActions(s.m[7])).toHaveCount(4);
    expect(await panel.labelsOf(panel.queueActions(s.m[7]))).toEqual(['Mark Late', 'Flag Issue', 'Decline', 'Noted']);
    await snapshot(page, 'queue');
  });
});
