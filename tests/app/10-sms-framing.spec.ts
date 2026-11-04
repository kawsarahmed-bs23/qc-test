import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/test';
import { env } from '../../config/environment';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '../../fixtures/localDb';
import { CommsPage } from '../../pages/AppPages';
import { API_CHANNEL, CommsApi, CommsComposer, CommsHostAdmin, MESSAGE_CHANNEL } from '../../pages/CommsSendGate';
import {
  SMS_OPT_OUT_LINE,
  SMS_SINGLE_SEGMENT,
  SmsPreviewApi,
  backdateSmsSentTo,
  framedSms,
  framingBudget,
  hostName,
  hostNameAfterDays,
  isFirstTextTo,
  jobDocName,
  latestOutboundId,
  storedMessageById,
  storedMessageContaining,
  toE164,
} from '../../pages/SmsFraming';
import { REPLY_LINK_CODE_LENGTH, REPLY_LINK_TOKEN, codeIn, replyLinkOf, replyLinkUrl, replyLinksOf, sha256Hex } from '../../pages/ReplyLinks';
import * as path from 'path';

const MARKER = 'E2E-QC780';
const QC780_ADMIN_STATE = path.join('.auth', env.name, 'qc780-app-admin.json');
const STATUS_CHECK = 20;
const FULFILLMENT_FIXED = 10;

const DRIVER_ROLE = `u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName LIKE '%Driver%')`;
const LIVE_ASSIGNMENT = `EXISTS (SELECT 1 FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK
  WHERE a.DriverUserID_FK = u.Id AND a.Active = 1 AND o.Active = 1 AND a.OrderAssignmentStatusID_FK NOT IN (8, 9))`;

interface FramingDrivers {
  sms: string;
  smsPhone: string;
  inApp: string;
  inAppPhone: string;
}

function pickDrivers(): FramingDrivers {
  const rows = querySingleValue(`SELECT STRING_AGG(CONCAT(u.Id, '|', u.PhoneNumber), ';') WITHIN GROUP (ORDER BY u.Id)
    FROM auth.Users u WHERE ${DRIVER_ROLE} AND u.IsActive = 1 AND ISNULL(u.PhoneNumber, '') <> '' AND ${LIVE_ASSIGNMENT}`) ?? '';
  const fresh = rows.split(';').filter(Boolean).map((row) => row.split('|')).filter(([, phone]) => noSmsEverSentTo(phone));
  if (fresh.length < 2) {
    throw new Error(`QC-780 needs two active drivers with a live assignment and no SMS ever sent to their phone (found ${fresh.length}).`);
  }
  return { sms: fresh[0][0], smsPhone: fresh[0][1], inApp: fresh[1][0], inAppPhone: fresh[1][1] };
}

function noSmsEverSentTo(phone: string): boolean {
  return querySingleValue(`SELECT COUNT(*) FROM app.Messages
    WHERE PhoneNumber = N'${toE164(phone)}' AND Direction = 20 AND Channel = 10 AND SentAt IS NOT NULL`) === '0';
}

function smsGoesToLogOnly(): boolean {
  return querySingleValue(
    `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = 'Twilio' AND PropertyName = 'FromPhoneNumber' AND ISNULL(PropertyValue, '') <> ''`,
  ) === '0';
}

test.describe('Dispatch SMS framing: host name and opt-out line on a first text (QC-780)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to pick drivers and read stored messages.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the send, ping and preview API cannot be called directly.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.skip(canSeedLocalDb() && !smsGoesToLogOnly(), 'Twilio FromPhoneNumber is set in app.EnvironmentSetting, so an SMS would really go out.');
  test.use({ storageState: QC780_ADMIN_STATE });

  let drivers: FramingDrivers;
  let afterMessageId: number;
  let host: string;

  test.beforeAll(async ({ browser }) => {
    host = hostName();
    drivers = pickDrivers();
    const output = runSeedScript('sms-framing-qc780.apply.sql', { SmsDriverId: drivers.sms, InAppDriverId: drivers.inApp });
    const match = output.match(/SEED after=(\d+)/);
    if (!match) throw new Error(`The QC-780 seed did not report its watermark:\n${output}`);
    afterMessageId = Number(match[1]);
    await CommsHostAdmin.signIn(browser, QC780_ADMIN_STATE);
  });

  test.afterAll(() => {
    try {
      if (drivers && afterMessageId !== undefined) {
        const output = runSeedScript('sms-framing-qc780.remove.sql', {
          AfterMessageId: String(afterMessageId),
          SmsDriverId: drivers.sms,
          InAppDriverId: drivers.inApp,
        });
        if (!/REMOVED left=0/.test(output)) throw new Error(`QC-780 messages are left behind:\n${output}`);
      }
    } finally {
      CommsHostAdmin.remove(QC780_ADMIN_STATE);
    }
  });

  async function openThread(page: Page, driverUserId: string): Promise<{ composer: CommsComposer; api: CommsApi }> {
    const thread = page.waitForResponse((r) => r.request().method() === 'GET'
      && new URL(r.url()).pathname.endsWith(`/messages/threads/${driverUserId}`), { timeout: 30_000 });
    await new CommsPage(page).open(driverUserId);
    expect((await thread).ok(), 'GET thread').toBe(true);
    const api = new CommsApi(page, env.appApiUrl!);
    await api.ready();
    return { composer: new CommsComposer(page), api };
  }

  async function sendSms(api: CommsApi, driverUserId: string, body: string): Promise<number> {
    const answer = await api.send(driverUserId, body, API_CHANNEL.Sms);
    expect(answer.status, `SMS send ${answer.text}`).toBe(200);
    const id = latestOutboundId(driverUserId, afterMessageId);
    expect(id, 'the stored SMS').not.toBeNull();
    return id!;
  }

  function expectStub(sid: string | null): void {
    expect(sid, 'the logging SMS sender stamps a STUB id; a real Twilio id starts SM').toMatch(/^STUB/);
  }

  test('SMSFMT-01 a first manual SMS to a phone with no SMS history is stored as "<HostName>: <body>" plus the opt-out line', async ({ page }) => {
    expect(isFirstTextTo(drivers.smsPhone)).toBe(true);
    const { composer } = await openThread(page, drivers.sms);
    const body = `${MARKER}-FIRST-${Date.now()}`;

    await composer.send(body, 'SMS');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });
    await expect(composer.sentText(body)).toContainText(`${host}: ${body}`);
    await expect(composer.sentText(body)).toContainText(SMS_OPT_OUT_LINE);

    const row = storedMessageContaining(body);
    expect(row.body).toBe(`${host}: ${body}\n${SMS_OPT_OUT_LINE}`);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    expect(row.phone).toBe(toE164(drivers.smsPhone));
    expectStub(row.sid);
  });

  test('SMSFMT-02 a second manual SMS straight after is stored exactly as typed', async ({ page }) => {
    const { composer } = await openThread(page, drivers.sms);
    const body = `${MARKER}-SECOND-${Date.now()}`;

    await composer.send(body, 'SMS');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });

    const row = storedMessageContaining(body);
    expect(row.body).toBe(body);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    expectStub(row.sid);
  });

  test('SMSFMT-03 once the latest SMS to that phone is 31 days old, the next SMS is framed again', async ({ page }) => {
    expect(hostNameAfterDays()).toBeLessThanOrEqual(31);
    expect(backdateSmsSentTo(drivers.smsPhone, afterMessageId, 31), 'spec-created SMS rows backdated').toBeGreaterThanOrEqual(2);
    expect(isFirstTextTo(drivers.smsPhone)).toBe(true);
    const { api } = await openThread(page, drivers.sms);
    const body = `${MARKER}-AFTER31-${Date.now()}`;

    const row = storedMessageById(await sendSms(api, drivers.sms, body));
    expect(row.body).toBe(framedSms(host, body));
    expectStub(row.sid);
  });

  test('SMSFMT-04 an in-app message is never framed, even to a phone with no SMS history', async ({ page }) => {
    expect(isFirstTextTo(drivers.inAppPhone)).toBe(true);
    const { composer } = await openThread(page, drivers.inApp);
    const body = `${MARKER}-INAPP-${Date.now()}`;

    await composer.send(body, 'In-app');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });

    const row = storedMessageContaining(body);
    expect(row.body).toBe(body);
    expect(row.channel).toBe(MESSAGE_CHANNEL.InApp);
    expect(row.sid).toBeNull();
  });

  test('SMSFMT-05 a body that already starts with "<HostName>:" is not prefixed again but still gets the opt-out line', async ({ page }) => {
    const { api } = await openThread(page, drivers.sms);

    for (const typedHost of [host, host.toUpperCase()]) {
      backdateSmsSentTo(drivers.smsPhone, afterMessageId, 31);
      expect(isFirstTextTo(drivers.smsPhone)).toBe(true);
      const body = `${typedHost}: ${MARKER}-PREFIXED-${Date.now()}`;

      const row = storedMessageById(await sendSms(api, drivers.sms, body));
      expect(row.body, `typed as "${typedHost}: ..."`).toBe(`${body}\n${SMS_OPT_OUT_LINE}`);
    }
  });

  test('SMSFMT-06 an in-app Status Ping reads "Status check <order>. How many loads done?" with no Reply line; an SMS ping after a recent text is unframed and ends with its reply link (QC-777)', async ({ page }) => {
    const { api } = await openThread(page, drivers.inApp);

    const inApp = await api.ping(drivers.inApp, API_CHANNEL.InApp);
    expect(inApp.status, `in-app ping ${inApp.text}`).toBe(200);
    const inAppRow = storedMessageById(latestOutboundId(drivers.inApp, afterMessageId)!);
    expect(inAppRow.messageType).toBe(STATUS_CHECK);
    expect(inAppRow.channel).toBe(MESSAGE_CHANNEL.InApp);
    expect(inAppRow.assignment).not.toBeNull();
    expect(inAppRow.body).toBe(`Status check ${jobDocName(inAppRow.assignment!)}. How many loads done?`);
    expect(inAppRow.body).not.toContain(REPLY_LINK_TOKEN);

    expect(isFirstTextTo(drivers.smsPhone), 'the SMS driver was texted in SMSFMT-05').toBe(false);
    const sms = await api.ping(drivers.sms, API_CHANNEL.Sms);
    expect(sms.status, `SMS ping ${sms.text}`).toBe(200);
    const smsRow = storedMessageById(latestOutboundId(drivers.sms, afterMessageId)!);
    expect(smsRow.messageType).toBe(STATUS_CHECK);
    expect(smsRow.channel).toBe(MESSAGE_CHANNEL.Sms);
    const code = codeIn(smsRow.body);
    expect(smsRow.body).toBe(`Status check ${jobDocName(smsRow.assignment!)}. How many loads done?\nReply: ${replyLinkUrl(code)}`);
    expect(replyLinkOf(smsRow.id).codeHash).toBe(sha256Hex(code));
    expect(replyLinksOf(inAppRow.id), 'an in-app ping gets no reply link').toBe(0);
    expectStub(smsRow.sid);
  });

  test('SMSFMT-07 the order-notify SMS preview joins origin and destination with " > ", shows the literal {ReplyLink} line and, with the real link in, fits a framed first text', async ({ page }) => {
    const orderId = Number(querySingleValue(`SELECT TOP 1 o.OrderID FROM app.Orders o WHERE o.Active = 1
      AND EXISTS (SELECT 1 FROM app.JobAddresses ja WHERE ja.JobID_FK = o.JobID_FK AND ja.Active = 1 AND ja.IsFrom = 1)
      AND EXISTS (SELECT 1 FROM app.JobAddresses ja WHERE ja.JobID_FK = o.JobID_FK AND ja.Active = 1 AND ja.IsTo = 1)
      ORDER BY o.OrderID DESC`));
    test.skip(!(orderId > 0), 'No active order has a job with both an origin and a destination address.');
    const jobId = Number(querySingleValue(`SELECT JobID_FK FROM app.Orders WHERE OrderID = ${orderId}`));
    await openThread(page, drivers.sms);

    const preview = await new SmsPreviewApi(page, env.appApiUrl!).preview({
      orderId,
      driverUserId: drivers.sms,
      timeWindowStart: '06:00',
      loadsAssigned: 3,
      fulfillmentType: FULFILLMENT_FIXED,
    });
    const body = preview.body ?? '';
    await test.info().attach('sms-preview-body', { body, contentType: 'text/plain' });

    expect(body.startsWith(`JOB${String(jobId).padStart(4, '0')} | `), body).toBe(true);
    expect(body).toContain(' > ');
    expect(body).not.toContain('→');
    expect(body).toContain('Start: 6:00am | 3 loads');
    expect(body.endsWith(`\nReply: ${REPLY_LINK_TOKEN}`), body).toBe(true);
    expect(body.split(REPLY_LINK_TOKEN)).toHaveLength(2);
    expect(body.startsWith(`${host}:`)).toBe(false);
    expect(body).not.toContain(SMS_OPT_OUT_LINE);
    const withLink = body.replace(REPLY_LINK_TOKEN, replyLinkUrl('X'.repeat(REPLY_LINK_CODE_LENGTH)));
    expect(withLink.length, `the preview with the real link, plus "${host}: " and the opt-out line, fits in ${SMS_SINGLE_SEGMENT}`).toBeLessThanOrEqual(framingBudget(host));
  });

  test('SMSFMT-08 a typed SMS longer than one segment is still sent and stored in full', async ({ page }) => {
    const { api } = await openThread(page, drivers.sms);
    const body = `${MARKER}-LONG-${Date.now()} ${'Load ticket details follow for the next run. '.repeat(5)}`.trim();
    expect(body.length).toBeGreaterThan(SMS_SINGLE_SEGMENT);
    const expected = isFirstTextTo(drivers.smsPhone) ? framedSms(host, body) : body;

    const row = storedMessageById(await sendSms(api, drivers.sms, body));
    expect(row.body).toBe(expected);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    expectStub(row.sid);
    test.info().annotations.push({ type: 'api-log', description: `The API should log "A dispatch SMS for driver ${drivers.sms} needs N segments" for message ${row.id}.` });
  });
});
