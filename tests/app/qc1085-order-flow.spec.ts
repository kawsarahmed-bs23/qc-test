import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env, TEST_DATA_DIR } from '@config/env.config';
import { PasswordGrantApi } from '@api/password-grant.api';
import { DriverSyncApi, isReplayed } from '@api/driver-sync.api';
import { DriverTicketSubmitApi, sha256Hex } from '@api/ticket-submit.api';

/**
 * QC-1085 (dev): one order end to end. Host UI creates a Job, an Order and the assignment to the demo driver; the Drivers API
 * runs the Driver App flow (accept, start trip, GPS ping, upload + submit ticket, end trip, a ticketless trip for reopenUntil,
 * finish day), every write with an Idempotency-Key and replayed; the Host UI is checked after each driver step.
 *
 * Dev only, writes data (named QC1070-TEST, left in place). Run: ENV=dev ALLOW_WRITES=true npx playwright test tests/app/qc1085-order-flow.spec.ts
 * Needs APP_ADMIN_* (app project session) and DRIVER_EMAIL / DRIVER_PASSWORD (one password grant, no retry).
 * SQS / dead-letter queue are not reachable from here: the spec checks the Host UI as the delivery proof and records that.
 */
const PREFIX = 'QC1070-TEST';
const TICKET_JPEG = path.join(TEST_DATA_DIR, 'qc803', 'logo-solid.jpg');
const HOST_UI_WAIT = { timeout: 60_000, intervals: [2_000, 3_000, 5_000] };

function hostDate(): { mdy: string; iso: string } {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
  const [y, m, d] = iso.split('-');
  return { mdy: `${m}/${d}/${y}`, iso };
}

async function pick(page: Page, combo: ReturnType<Page['getByRole']>, option?: string): Promise<void> {
  await combo.click();
  const options = page.getByRole('option');
  await (option ? options.filter({ hasText: option }).first() : options.first()).click();
}

async function orderPanelText(page: Page, orderId: number): Promise<string> {
  await page.goto(`/#/dispatch/order/${orderId}`);
  await expect(page.getByText('Assigned Trucks')).toBeVisible();
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
}

test.describe(`QC-1085 dev order flow (Host to Drivers API and back)`, { tag: ['@write'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(env.name !== 'dev', 'Dev only.');
  test.skip(!env.allowWrites, 'Set ALLOW_WRITES=true to create the QC1070-TEST data.');
  test.skip(!env.driver || !env.driversApiUrl, 'Needs DRIVER_EMAIL / DRIVER_PASSWORD and DRIVERS_API_URL.');

  const day = hostDate();
  const keys = { accept: randomUUID(), begin: randomUUID(), ping: randomUUID(), upload: randomUUID(), submit: randomUUID(), end: randomUUID(), begin2: randomUUID(), end2: randomUUID(), finish: randomUUID() };
  const run = { jobId: 0, jobNumber: '', orderId: 0, assignmentUuid: '', tripUuid: '', trip2Uuid: '', ticketNumber: `${PREFIX}-${Date.now() % 100_000}`, gps: randomUUID() };
  let api: DriverSyncApi;
  let tickets: DriverTicketSubmitApi;
  const photo = fs.readFileSync(TICKET_JPEG);
  const file = { name: `${PREFIX}-ticket.jpg`, mimeType: 'image/jpeg', buffer: photo };

  test.beforeAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const grant = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
    // One attempt only: a rejected login must not be retried (lockout risk).
    expect(grant.status, `driver password grant answered ${grant.status} ${grant.body.error ?? ''}`).toBe(200);
    api = new DriverSyncApi(request, grant.body.access_token!);
    tickets = new DriverTicketSubmitApi(request, grant.body.access_token!);
    // One open load per driver (D67): close any load a previous failed run left open so this run can start its own.
    for (const open of (await api.changes()).trips.filter((t) => t.status === 'active')) {
      await api.endHaul(open.tripUuid, randomUUID());
    }
  });

  test('1. Host: create the Job', async ({ page }) => {
    await page.goto('/#/jobs/job-add');
    await pick(page, page.getByRole('combobox', { name: 'Sales Person' }));
    await pick(page, page.getByRole('combobox', { name: 'Customer', exact: true }));
    await page.getByRole('textbox', { name: /Customer PO/ }).fill(`${PREFIX}-PO`);
    await page.getByRole('combobox', { name: 'Material' }).click();
    await page.getByRole('combobox', { name: 'Material' }).pressSequentially('#57');
    await page.getByRole('option').filter({ hasText: '#57 Stone' }).first().click();
    await page.getByRole('textbox', { name: /Dispatch Notes/i }).fill(`${PREFIX} job`);
    await page.getByRole('button', { name: 'Next' }).click();
    await pick(page, page.getByRole('combobox', { name: 'From (Quarry)' }));
    await page.getByRole('textbox', { name: /To name/ }).fill(`${PREFIX} Site`);
    await page.getByRole('textbox', { name: 'Address 1' }).fill('1 Test Road');
    await page.getByRole('textbox', { name: 'City' }).fill('Austin');
    await page.getByRole('textbox', { name: 'ZIP' }).fill('78701');
    await page.getByRole('combobox', { name: 'State' }).click();
    await page.getByRole('option', { name: 'Texas' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('textbox', { name: /Effective From/ }).fill(day.mdy);
    await page.getByRole('spinbutton', { name: 'Customer Rate' }).fill('10');
    await page.getByRole('spinbutton', { name: 'Truck Rate' }).fill('8');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Job saved')).toBeVisible();
    await expect(page).toHaveURL(/#\/jobs\/job\/(\d+)/);
    run.jobId = Number(/job\/(\d+)/.exec(page.url())![1]);
    await expect(page.getByText(/JOB\d+/).first()).toBeVisible();
    run.jobNumber = ((await page.getByText(/JOB\d+/).first().innerText()).match(/JOB\d+/) ?? [''])[0];
    expect(run.jobNumber, 'the saved job shows its number').not.toBe('');
  });

  test('2. Host: create the Order on the Job', async ({ page }) => {
    await page.goto('/#/dispatch/orders');
    await page.getByRole('link', { name: 'New Order' }).click();
    await page.getByRole('combobox', { name: /Job/ }).first().click();
    await page.keyboard.type(String(run.jobId));
    await page.getByRole('option').filter({ hasText: run.jobNumber }).first().click();
    await page.getByRole('textbox', { name: /Start Date/ }).fill(day.mdy);
    await pick(page, page.getByRole('combobox', { name: /Truck Type/ }), 'End Dump');
    await pick(page, page.getByRole('combobox', { name: /Trucks Per Day/ }), '1');
    await page.getByRole('spinbutton', { name: /Total Quantity/ }).or(page.getByRole('textbox', { name: /Total Quantity/ })).fill('20');
    await page.getByText('Save Order', { exact: true }).click();
    await expect(page.getByText(/Order saved/i)).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: run.jobNumber }).first();
    await expect(row).toBeVisible();
    run.orderId = Number(((await row.getByRole('link').first().innerText()).match(/\d+/) ?? ['0'])[0]);
    expect(run.orderId, 'the order number is shown on the Orders list').toBeGreaterThan(0);
  });

  test('3. Host: assign the Order to the demo driver (truck JMA)', async ({ page }) => {
    await page.goto(`/#/dispatch/schedule?orderId=${run.orderId}&date=${day.iso}`);
    await page.getByRole('button', { name: /Assign Truck/ }).click();
    await pick(page, page.getByRole('combobox', { name: /Order/ }).first());
    await pick(page, page.getByRole('combobox', { name: /Vendor/ }), 'Juan Miguel Alfonso Valladares');
    await pick(page, page.getByRole('combobox', { name: /Truck/ }), 'JMA');
    await page.getByRole('dialog').getByText('Save', { exact: true }).click();
    await expect(page.getByText('Truck assigned')).toBeVisible();
  });

  test('4. Driver: the offered Order is listed', async () => {
    await expect
      .poll(async () => {
        const sync = await api.changes();
        const mine = sync.assignments.find((a) => a.jobDocNameWithPrefix === run.jobNumber);
        run.assignmentUuid = mine?.orderAssignmentUuid ?? '';
        return mine?.status;
      }, { message: 'JobOffered reaches the Drivers API', ...HOST_UI_WAIT })
      .toBe('pending');
  });

  test('5. Driver: accept (and replay it) - Host shows accepted', async ({ page }) => {
    const first = await api.accept(run.assignmentUuid, keys.accept);
    expect(first.status(), await first.text()).toBe(202);
    const replay = await api.accept(run.assignmentUuid, keys.accept);
    expect(replay.status()).toBe(202);
    expect(isReplayed(replay), 'accept replay is flagged Idempotent-Replayed').toBe(true);
    await expect.poll(async () => orderPanelText(page, run.orderId), { message: 'Host shows the assignment accepted', ...HOST_UI_WAIT }).toMatch(/Accepted|Running/);
  });

  test('6. Driver: start trip (and replay it) - Host shows Running and Order In Progress', async ({ page }) => {
    const begun = await api.beginHaul(run.assignmentUuid, keys.begin);
    expect(begun.status(), await begun.text()).toBe(202);
    run.tripUuid = (await begun.json()).data.tripUuid as string;
    const replay = await api.beginHaul(run.assignmentUuid, keys.begin);
    expect(replay.status()).toBe(202);
    expect(isReplayed(replay)).toBe(true);
    expect((await replay.json()).data.tripUuid, 'the replay returns the same trip').toBe(run.tripUuid);
    await expect.poll(async () => orderPanelText(page, run.orderId), { message: 'Host shows Running / In Progress', ...HOST_UI_WAIT }).toMatch(/Running/);
    await expect(page.getByRole('combobox', { name: 'Status' })).toContainText('In Progress');
    const trips = (await api.changes()).trips.filter((t) => t.orderAssignmentUuid === run.assignmentUuid);
    expect(trips, 'one trip only after the replay').toHaveLength(1);
  });

  test('7. Driver: GPS ping', async () => {
    const response = await tickets.gpsPings(
      [{ TripGpsUUID: run.gps, lat: 30.2672, lng: -97.7431, isMoving: true, recordedAt: new Date().toISOString(), accuracyMeters: 10, tripUuid: run.tripUuid, orderAssignmentUuid: run.assignmentUuid }],
      `${PREFIX}-device`,
    );
    expect(response.status(), await response.text()).toBe(202);
    expect((await response.json()).data.accepted).toBe(1);
    // Known gap found in the first run: the pings route does not read Idempotency-Key (no Idempotent-Replayed header).
  });

  test('8. Driver: upload the photo and submit the ticket (replayed) - Host shows one ticket', async ({ page }) => {
    const upload = await api.uploadTicket(run.tripUuid, file, { key: keys.upload, sha256: sha256Hex(photo) });
    expect(upload.status(), await upload.text()).toBe(202);
    const uploadReplay = await api.uploadTicket(run.tripUuid, file, { key: keys.upload, sha256: sha256Hex(photo) });
    expect(isReplayed(uploadReplay), 'upload replay is flagged').toBe(true);
    const values = { ticketNumber: run.ticketNumber, ticketDate: day.iso, ticketQuantity: 20, submittedAt: new Date().toISOString() };
    const submit = await tickets.submit(run.tripUuid, values, keys.submit);
    expect(submit.status(), await submit.text()).toBe(202);
    const submitReplay = await tickets.submit(run.tripUuid, values, keys.submit);
    expect(submitReplay.status()).toBe(202);
    expect(isReplayed(submitReplay), 'submit replay is flagged').toBe(true);

    await page.goto('/#/tickets');
    await page.getByRole('textbox', { name: /Filter/ }).fill(run.ticketNumber);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect
      .poll(async () => (await page.getByRole('row').filter({ hasText: run.ticketNumber }).count()) + (await page.getByText(run.ticketNumber).count()), {
        message: 'TicketSubmitted reaches the Host Tickets list',
        ...HOST_UI_WAIT,
      })
      .toBeGreaterThan(0);
    await expect(page.getByText(run.ticketNumber, { exact: false }).first()).toBeVisible();
    await expect(page.getByText(run.jobNumber).first()).toBeVisible();
    expect(await page.getByText(run.jobNumber).count(), 'the replays did not create a second ticket').toBe(1);
  });

  test('9. Driver: end trip (replayed) - Host shows the load hauled', async ({ page }) => {
    const ended = await api.endHaul(run.tripUuid, keys.end);
    expect(ended.status(), await ended.text()).toBe(202);
    const replay = await api.endHaul(run.tripUuid, keys.end);
    expect(isReplayed(replay)).toBe(true);
    await expect
      .poll(async () => {
        await page.goto('/#/dispatch/tickets');
        return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
      }, { message: 'Ticket Activity shows 1 hauled for the JMA truck', ...HOST_UI_WAIT })
      .toMatch(/JMA[\s\S]*1\s*\/\s*\d+\s*loads[\s\S]*1 HAULED/);
  });

  test('10. Driver: a trip with NO ticket gets reopenUntil (needs Drivers API PR #42 on dev)', async () => {
    const begun = await api.beginHaul(run.assignmentUuid, keys.begin2);
    expect(begun.status(), await begun.text()).toBe(202);
    run.trip2Uuid = (await begun.json()).data.tripUuid as string;
    expect(run.trip2Uuid).not.toBe(run.tripUuid);
    const ended = await api.endHaul(run.trip2Uuid, keys.end2);
    expect(ended.status(), await ended.text()).toBe(202);
    const trip = (await api.changes()).trips.find((t) => t.tripUuid === run.trip2Uuid);
    expect((trip as { reopenUntil?: string | null } | undefined)?.reopenUntil, 'reopenUntil is set on a finished trip with no ticket (PR #42 build)').toBeTruthy();
  });

  test('11. Driver: finish the day (replayed) - Host shows the assignment complete', async ({ page }) => {
    const finish = () =>
      api['request'].post(`${env.driversApiUrl}/driver/assignments/${run.assignmentUuid}/finish-day`, {
        headers: { Authorization: `Bearer ${api['accessToken']}`, 'Idempotency-Key': keys.finish },
        data: { isOfflineSync: false, deviceCompletedAt: new Date().toISOString() },
      });
    const done = await finish();
    expect(done.status(), await done.text()).toBe(202);
    const replay = await finish();
    expect(replay.status()).toBe(202);
    expect(isReplayed(replay)).toBe(true);
    await expect.poll(async () => orderPanelText(page, run.orderId), { message: 'Host shows the assignment complete', ...HOST_UI_WAIT }).toMatch(/Complete/);
  });
});
