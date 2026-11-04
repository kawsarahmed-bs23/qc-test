import type { Page } from '@playwright/test';
import { test, expect } from '../../fixtures/test';
import { env } from '../../config/environment';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '../../fixtures/localDb';
import { CommsPage } from '../../pages/AppPages';
import { API_CHANNEL, CommsApi, CommsHostAdmin, MESSAGE_CHANNEL, QC804_ADMIN_STATE } from '../../pages/CommsSendGate';
import { ASSIGNMENT_STATUS, TRIP_NOTE_STATUS } from '../../pages/MessageLink';
import { SMS_SINGLE_SEGMENT, jobDocName } from '../../pages/SmsFraming';
import {
  AI,
  AssignmentNotifyApi,
  DIRECTION,
  LINK_NOT_FOUND,
  MESSAGE_TYPE,
  REPLY_LINK_ORIGIN,
  REPLY_LINK_TOKEN,
  ReplyLinkApi,
  ReplyLinkThread,
  TOO_MANY_REQUESTS,
  codeIn,
  expectedExpiryUtc,
  gsm7Units,
  latestOutbound,
  linkReplies,
  messageRow,
  randomCode,
  replyLinkOf,
  replyLinkReadOnlyDays,
  replyLinkUrl,
  replyLinksOf,
  rowsHoldingText,
  setReplyLinkExpiry,
  sha256Hex,
} from '../../pages/ReplyLinks';

const MARKER = 'E2E-QC777';
const APP_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)`;
const DRIVER_ROLE = `u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName LIKE '%Driver%')`;
const CANCELED = 8;

interface Seeded {
  driver: string;
  order: number;
  today: number;
  accept: number;
  cant: number;
  withdraw: number;
  watermark: number;
}

interface SentLink {
  messageId: number;
  code: string;
}

function pickDriver(): string {
  const driver = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${DRIVER_ROLE} AND u.IsActive = 1 AND ISNULL(u.PhoneNumber, '') <> ''
    AND EXISTS (SELECT 1 FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK JOIN app.Jobs j ON j.JobID = o.JobID_FK
      JOIN auth.Organisations t ON t.OrganisationID = a.TruckID_FK
      WHERE a.DriverUserID_FK = u.Id AND a.Active = 1 AND o.Active = 1 AND a.AssignmentType = 10 AND j.IsNightShift = 0
        AND a.TruckID_FK = u.OrganisationIdFk AND t.ParentOrganisationIdFk = a.VendorID_FK)
    AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id AND a.Active = 1
      AND a.AssignmentDate >= DATEADD(DAY, -1, ${APP_TODAY}) AND ISNULL(a.Notes, '') <> N'${MARKER}')
    ORDER BY u.Id DESC`);
  if (!driver) throw new Error('QC-777 needs an active driver with a phone, a day-shift assignment on their own truck to copy and no live work from yesterday on.');
  return driver;
}

function seed(driver: string): Seeded {
  const output = runSeedScript('reply-links-qc777.apply.sql', { DriverId: driver });
  const line = output.split(/\r?\n/).find((l) => l.includes('SEED order='));
  if (!line) {
    runSeedScript('reply-links-qc777.remove.sql');
    throw new Error(`The QC-777 seed did not report its rows:\n${output}`);
  }
  const v = Object.fromEntries(line.trim().replace(/^SEED /, '').split(';').map((p) => p.split('=')).map(([k, n]) => [k, Number(n)]));
  return { driver, order: v.order, today: v.today, accept: v.accept, cant: v.cant, withdraw: v.withdraw, watermark: v.watermark };
}

function num(query: string): number {
  return Number(querySingleValue(query));
}

function smsGoesToLogOnly(): boolean {
  return querySingleValue(
    `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = 'Twilio' AND PropertyName = 'FromPhoneNumber' AND ISNULL(PropertyValue, '') <> ''`,
  ) === '0';
}

function assignmentStatus(id: number): number {
  return num(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${id}`);
}

function historyCount(id: number, text: string): number {
  return num(`SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${id}
    AND OrderAssignmentHistoryData = N'${text.replace(/'/g, "''")}'`);
}

function tripNotes(assignmentId: number, statusType: number): number {
  return num(`SELECT COUNT(*) FROM app.TripNotes WHERE OrderAssignmentID_FK = ${assignmentId} AND StatusType = ${statusType}`);
}

function rowCounts(assignmentId: number): string {
  return querySingleValue(`SELECT CONCAT((SELECT COUNT(*) FROM app.Messages), '|', (SELECT COUNT(*) FROM app.MessageReplyLinks), '|',
    (SELECT COUNT(*) FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${assignmentId}), '|',
    (SELECT COUNT(*) FROM app.TripNotes WHERE OrderAssignmentID_FK = ${assignmentId}))`) ?? '';
}

test.describe('Reply links on order-notify and Status Ping SMS (QC-777)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed assignments and read stored SMS.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the notify, ping and reply-link API cannot be called directly.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.skip(canSeedLocalDb() && !smsGoesToLogOnly(), 'Twilio FromPhoneNumber is set in app.EnvironmentSetting, so an SMS would really go out.');
  test.use({ storageState: QC804_ADMIN_STATE });

  let s: Seeded;
  let links: ReplyLinkApi;
  const sent: Partial<Record<'accept' | 'cant' | 'today' | 'ping' | 'withdraw' | 'expire', SentLink>> = {};

  test.beforeAll(async ({ browser }) => {
    await CommsHostAdmin.signIn(browser);
    s = seed(pickDriver());
    links = await ReplyLinkApi.open();
  });

  test.afterAll(async () => {
    try {
      await links?.close();
      const output = runSeedScript('reply-links-qc777.remove.sql');
      if (!/REMOVED orders=0;assignments=0;messages=0/.test(output)) throw new Error(`QC-777 rows are left behind:\n${output}`);
    } finally {
      CommsHostAdmin.remove();
    }
  });

  async function signedIn(page: Page): Promise<{ notify: AssignmentNotifyApi; comms: CommsApi }> {
    await new CommsPage(page).open(s.driver);
    const notify = new AssignmentNotifyApi(page, env.appApiUrl!);
    await notify.ready();
    return { notify, comms: new CommsApi(page, env.appApiUrl!) };
  }

  async function sendNotify(page: Page, assignmentId: number, smsBody: string | null = null): Promise<SentLink & { body: string }> {
    const { notify } = await signedIn(page);
    const before = latestOutbound(s.driver, s.watermark, MESSAGE_TYPE.OrderNotify) ?? s.watermark;
    const answer = await notify.notify(assignmentId, smsBody);
    expect(answer.status, `PUT assignment ${assignmentId} with sendSms ${answer.text}`).toBe(200);
    const id = latestOutbound(s.driver, before, MESSAGE_TYPE.OrderNotify);
    expect(id, 'the stored order-notify SMS').not.toBeNull();
    const row = messageRow(id!);
    expect(row.assignment).toBe(assignmentId);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    return { messageId: id!, code: codeIn(row.body), body: row.body ?? '' };
  }

  async function sendSmsPing(page: Page): Promise<SentLink & { body: string; assignment: number | null }> {
    const { comms } = await signedIn(page);
    const before = latestOutbound(s.driver, s.watermark, MESSAGE_TYPE.StatusCheck) ?? s.watermark;
    const answer = await comms.ping(s.driver, API_CHANNEL.Sms);
    expect(answer.status, `SMS ping ${answer.text}`).toBe(200);
    const id = latestOutbound(s.driver, before, MESSAGE_TYPE.StatusCheck);
    expect(id, 'the stored SMS Status Ping').not.toBeNull();
    const row = messageRow(id!);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    return { messageId: id!, code: codeIn(row.body), body: row.body ?? '', assignment: row.assignment };
  }

  test('RLINK-01 an order-notify SMS carries a 10-character reply link whose code is stored only as its SHA-256, and fits one GSM-7 segment', async ({ page }) => {
    const notify = await sendNotify(page, s.accept);
    sent.accept = notify;
    await test.info().attach('order-notify-sms', { body: notify.body, contentType: 'text/plain' });

    const row = messageRow(notify.messageId);
    expect(row.messageType).toBe(MESSAGE_TYPE.OrderNotify);
    expect(row.direction).toBe(DIRECTION.Outbound);
    expect(row.sid, 'the logging SMS sender stamps a STUB id').toMatch(/^STUB/);
    expect(notify.body).toContain(replyLinkUrl(notify.code));
    expect(notify.body).not.toContain(REPLY_LINK_TOKEN);
    expect(notify.body).toContain(`${jobDocName(s.accept)} | `);

    expect(replyLinksOf(notify.messageId)).toBe(1);
    const link = replyLinkOf(notify.messageId);
    expect(link.codeHash).toBe(sha256Hex(notify.code));
    expect(link.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rowsHoldingText(notify.code), 'the plain code is stored nowhere in MessageReplyLinks').toBe(0);
    expect(link).toMatchObject({ answeredOption: null, answeredAt: null, answerMessageId: null, active: 1 });
    expect(link.expiresAt, "ExpiresAt is the end of the assignment's day (tomorrow) in app time, as UTC").toBe(expectedExpiryUtc(1));

    const units = gsm7Units(notify.body);
    expect(units, `every character is GSM-7:\n${notify.body}`).not.toBeNull();
    expect(units!, 'one SMS segment').toBeLessThanOrEqual(SMS_SINGLE_SEGMENT);
  });

  test('RLINK-02 a Status Ping by SMS carries a reply link that expires at the end of today; an in-app ping has no link, no token and no Reply line', async ({ page }) => {
    const ping = await sendSmsPing(page);
    sent.ping = ping;
    expect(ping.assignment).toBe(s.today);
    expect(ping.body).toContain(`Status check ${jobDocName(s.today)}. How many loads done?\nReply: ${replyLinkUrl(ping.code)}`);
    expect(replyLinksOf(ping.messageId)).toBe(1);
    expect(replyLinkOf(ping.messageId).codeHash).toBe(sha256Hex(ping.code));
    expect(replyLinkOf(ping.messageId).expiresAt).toBe(expectedExpiryUtc(0));

    const { comms } = await signedIn(page);
    const answer = await comms.ping(s.driver, API_CHANNEL.InApp);
    expect(answer.status, `in-app ping ${answer.text}`).toBe(200);
    const inAppId = latestOutbound(s.driver, ping.messageId, MESSAGE_TYPE.StatusCheck);
    expect(inAppId).not.toBeNull();
    const inApp = messageRow(inAppId!);
    expect(inApp.channel).toBe(MESSAGE_CHANNEL.InApp);
    expect(inApp.body).toBe(`Status check ${jobDocName(s.today)}. How many loads done?`);
    expect(inApp.body).not.toContain(REPLY_LINK_TOKEN);
    expect(inApp.body).not.toContain('Reply:');
    expect(replyLinksOf(inAppId!)).toBe(0);
  });

  test('RLINK-03 GET on a link three times returns the same body and changes no row; it shows the job, host and the accept/cant/question options', async () => {
    const link = sent.accept!;
    const counts = rowCounts(s.accept);
    const updated = replyLinkOf(link.messageId).updated;
    const status = assignmentStatus(s.accept);

    const answers = [await links.get(link.code), await links.get(link.code), await links.get(link.code)];
    for (const a of answers) expect(a.status, a.text).toBe(200);
    expect(answers[1].text).toBe(answers[0].text);
    expect(answers[2].text).toBe(answers[0].text);

    expect(rowCounts(s.accept), 'Messages, MessageReplyLinks, history and trip-note counts').toBe(counts);
    expect(replyLinkOf(link.messageId).updated).toBe(updated);
    expect(assignmentStatus(s.accept)).toBe(status);

    const view = answers[0].view!;
    expect(view).toMatchObject({ kind: 'message', state: 'open', reply: null, text: messageRow(link.messageId).body });
    expect(view.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(view.host.name, 'host.name').toBeTruthy();
    expect(view.host).toHaveProperty('logoUrl');
    expect(view.job).toMatchObject({ number: jobDocName(s.accept), start: '6:30 AM' });
    expect(view.job).toHaveProperty('from');
    expect(view.job).toHaveProperty('to');
    expect(view.job!.loads).toBeGreaterThan(0);
    expect(view.options.map((o) => o.key)).toEqual(['accept', 'cant', 'question']);
    expect(view.options.find((o) => o.key === 'question')!.needsComment).toBe(true);
    expect(view.options.filter((o) => o.needsComment).map((o) => o.key)).toEqual(['question']);
  });

  test('RLINK-04 accept on a Pending assignment accepts it, writes history and a Link-channel reply shown with a "Link" tag; a second accept is refused, a comment still goes through', async ({ page }) => {
    const link = sent.accept!;
    expect(assignmentStatus(s.accept)).toBe(ASSIGNMENT_STATUS.Pending);

    const answer = await links.reply(link.code, { option: 'accept', comment: null });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.view!.reply).toMatchObject({ option: 'accept', label: 'Accept', comment: null });
    expect(answer.view!.reply!.at).toMatch(/Z$/);
    expect(answer.view!.state).toBe('open');

    expect(assignmentStatus(s.accept)).toBe(ASSIGNMENT_STATUS.Accepted);
    expect(historyCount(s.accept, 'Driver accepted the assignment.')).toBe(1);
    expect(historyCount(s.accept, `Driver answered by reply link (message #${link.messageId}).`)).toBe(1);

    const replies = linkReplies(link.messageId);
    expect(replies).toHaveLength(1);
    const reply = messageRow(replies[0]);
    expect(reply).toMatchObject({
      direction: DIRECTION.Inbound,
      messageType: MESSAGE_TYPE.StatusReply,
      channel: MESSAGE_CHANNEL.Link,
      replyTo: link.messageId,
      assignment: s.accept,
      body: 'Accept',
      ai: AI.Noted,
    });
    expect(replyLinkOf(link.messageId)).toMatchObject({ answeredOption: 'accept', answerMessageId: replies[0] });
    expect(replyLinkOf(link.messageId).answeredAt).not.toBeNull();

    await new CommsPage(page).open(s.driver);
    const thread = new ReplyLinkThread(page);
    await expect(thread.channelTag(replies[0])).toContainText('Link', { timeout: 15_000 });
    await expect(thread.channelIcon(replies[0])).toHaveText('link');
    await expect(thread.channelTag(replies[0])).toHaveAttribute('aria-label', 'Channel: Link');
    await thread.channelTag(replies[0]).hover();
    await expect(thread.tooltip()).toHaveText('Answered on the reply-link page from the text message.');
    await test.info().attach('link-reply-in-thread', { body: await page.screenshot(), contentType: 'image/png' });

    const again = await links.reply(link.code, { option: 'accept' });
    expect(again.status, again.text).toBe(400);
    expect(again.text).toContain('already been answered');

    const comment = `${MARKER} gate code is 4411`;
    const commented = await links.reply(link.code, { option: null, comment });
    expect(commented.status, commented.text).toBe(200);
    expect(commented.view!.reply).toMatchObject({ option: 'accept' });
    const after = linkReplies(link.messageId);
    expect(after).toHaveLength(2);
    expect(messageRow(after[1])).toMatchObject({ channel: MESSAGE_CHANNEL.Link, body: comment, replyTo: link.messageId });
    expect(replyLinkOf(link.messageId).answerMessageId, 'a comment does not replace the answer').toBe(replies[0]);
    expect(assignmentStatus(s.accept)).toBe(ASSIGNMENT_STATUS.Accepted);
  });

  test("RLINK-05 cant on another Pending assignment rejects it and the reply is classified Can't Make It", async ({ page }) => {
    const link = await sendNotify(page, s.cant);
    sent.cant = link;

    const answer = await links.reply(link.code, { option: 'cant' });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.view!.reply).toMatchObject({ option: 'cant', label: "Can't make it" });

    expect(assignmentStatus(s.cant)).toBe(ASSIGNMENT_STATUS.Rejected);
    expect(historyCount(s.cant, 'Driver rejected the assignment.')).toBe(1);
    expect(historyCount(s.cant, `Driver answered by reply link (message #${link.messageId}).`)).toBe(1);
    const replies = linkReplies(link.messageId);
    expect(replies).toHaveLength(1);
    expect(messageRow(replies[0])).toMatchObject({ channel: MESSAGE_CHANNEL.Link, body: "Can't make it", ai: AI.CantMakeIt, isActioned: 1 });
  });

  test('RLINK-06 question needs a comment; with one it is stored as "Question: <comment>" and left for review', async ({ page }) => {
    const link = await sendNotify(page, s.today);
    sent.today = link;
    expect(assignmentStatus(s.today)).toBe(ASSIGNMENT_STATUS.Accepted);

    const bare = await links.reply(link.code, { option: 'question' });
    expect(bare.status, bare.text).toBe(400);
    expect(bare.text).toContain('Please add a comment with this reply.');
    expect(linkReplies(link.messageId)).toHaveLength(0);

    const answer = await links.reply(link.code, { option: 'question', comment: `${MARKER} which pit gate?` });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.view!.reply).toMatchObject({ option: 'question', comment: `${MARKER} which pit gate?` });
    const replies = linkReplies(link.messageId);
    expect(replies).toHaveLength(1);
    expect(messageRow(replies[0])).toMatchObject({
      channel: MESSAGE_CHANNEL.Link, body: `Question: ${MARKER} which pit gate?`, ai: AI.Unknown, isActioned: 0,
    });
    expect(assignmentStatus(s.today), 'a question changes no status').toBe(ASSIGNMENT_STATUS.Accepted);
  });

  test('RLINK-07 a Status Ping answered "late" is classified Late and writes a Late trip note, with no status change', async () => {
    const link = sent.ping!;
    const view = await links.get(link.code);
    expect(view.view!.options.map((o) => o.key)).toEqual(['on-track', 'late', 'problem', 'question']);
    expect(view.view!.options.filter((o) => o.needsComment).map((o) => o.key)).toEqual(['problem', 'question']);
    const lateNotes = tripNotes(s.today, TRIP_NOTE_STATUS.Late);

    const answer = await links.reply(link.code, { option: 'late' });
    expect(answer.status, answer.text).toBe(200);
    const replies = linkReplies(link.messageId);
    expect(replies).toHaveLength(1);
    expect(messageRow(replies[0])).toMatchObject({ channel: MESSAGE_CHANNEL.Link, body: 'Running late', ai: AI.Late, assignment: s.today });
    expect(tripNotes(s.today, TRIP_NOTE_STATUS.Late)).toBe(lateNotes + 1);
    expect(assignmentStatus(s.today)).toBe(ASSIGNMENT_STATUS.Accepted);
  });

  test('RLINK-08 a canceled assignment withdraws its link: GET says "withdrawn", an option is refused, a comment is still taken', async ({ page }) => {
    const link = await sendNotify(page, s.withdraw);
    sent.withdraw = link;
    expect((await links.get(link.code)).view!.state).toBe('open');

    querySingleValue(`UPDATE app.OrderAssignments SET OrderAssignmentStatusID_FK = ${CANCELED} WHERE OrderAssignmentID = ${s.withdraw} AND Notes = N'${MARKER}'`);
    const view = await links.get(link.code);
    expect(view.status, view.text).toBe(200);
    expect(view.view!.state).toBe('withdrawn');

    const option = await links.reply(link.code, { option: 'accept' });
    expect(option.status, option.text).toBe(400);
    expect(option.text).toContain('can no longer be answered');
    expect(assignmentStatus(s.withdraw)).toBe(CANCELED);

    const comment = await links.reply(link.code, { comment: `${MARKER} ok, thanks` });
    expect(comment.status, comment.text).toBe(200);
    expect(comment.view!.state).toBe('withdrawn');
    expect(linkReplies(link.messageId)).toHaveLength(1);
    expect(replyLinkOf(link.messageId).answeredOption).toBeNull();
  });

  test('RLINK-09 past ExpiresAt the link reads "expired" and refuses an option; past the read-only days it is a 404 identical to an unknown code', async ({ page }) => {
    const link = await sendSmsPing(page);
    sent.expire = link;

    setReplyLinkExpiry(link.messageId, -60);
    const expired = await links.get(link.code);
    expect(expired.status, expired.text).toBe(200);
    expect(expired.view!.state).toBe('expired');
    const option = await links.reply(link.code, { option: 'on-track' });
    expect(option.status, option.text).toBe(400);
    expect(option.text).toContain('can no longer be answered');

    setReplyLinkExpiry(link.messageId, -(replyLinkReadOnlyDays() * 24 * 60 + 60));
    const dead = await links.get(link.code);
    const unknown = await links.get(randomCode());
    const malformed = await links.get('abc');
    expect(dead.status, dead.text).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(dead.text).toBe(unknown.text);
    expect(malformed.text).toBe(unknown.text);
    expect(dead.errors).toEqual([LINK_NOT_FOUND]);
    const deadReply = await links.reply(link.code, { comment: `${MARKER} late reply` });
    expect(deadReply.status).toBe(404);
    expect(deadReply.text).toBe(unknown.text);
    expect(linkReplies(link.messageId)).toHaveLength(0);
  });

  test('RLINK-10 a dispatcher-edited order SMS without the token gets a "Reply: <url>" line; with the token the link replaces it', async ({ page }) => {
    const plain = `${MARKER} edited body, no token`;
    const appended = await sendNotify(page, s.accept, plain);
    expect(appended.body).toContain(`${plain}\nReply: ${replyLinkUrl(appended.code)}`);
    expect(appended.body.match(new RegExp(replyLinkUrl('').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'), 'g'))).toHaveLength(1);
    expect(replyLinkOf(appended.messageId).codeHash).toBe(sha256Hex(appended.code));

    const tokened = `${MARKER} open ${REPLY_LINK_TOKEN} to answer`;
    const replaced = await sendNotify(page, s.accept, tokened);
    expect(replaced.body).toContain(`${MARKER} open ${replyLinkUrl(replaced.code)} to answer`);
    expect(replaced.body).not.toContain(REPLY_LINK_TOKEN);
    expect(replaced.body).not.toContain('Reply: https://');
    expect(replaced.code).not.toBe(appended.code);
    expect(replyLinkOf(replaced.messageId).codeHash).toBe(sha256Hex(replaced.code));
  });

  test('RLINK-11 CORS lets https://drivers.quarryconnect.com call the reply API and not another origin', async () => {
    const code = randomCode();
    const allowed = await links.preflight(code, REPLY_LINK_ORIGIN);
    expect(allowed.status, JSON.stringify(allowed.headers)).toBeLessThan(300);
    expect(allowed.headers['access-control-allow-origin']).toBe(REPLY_LINK_ORIGIN);

    const evil = await links.preflight(code, 'https://evil.example');
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('RLINK-12 more than 10 replies a minute from one address get 429 with Retry-After and the "Too many requests" error', async () => {
    const code = randomCode();
    let limited: Awaited<ReturnType<ReplyLinkApi['replyOnce']>> | null = null;
    for (let i = 0; i < 12 && !limited; i++) {
      const answer = await links.replyOnce(code, { comment: `${MARKER} burst ${i}` });
      if (answer.status === 429) limited = answer;
      else expect(answer.status, answer.text).toBe(404);
    }
    expect(limited, 'a 429 within 12 replies').not.toBeNull();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    expect(limited!.errors).toEqual([TOO_MANY_REQUESTS]);
  });
});
