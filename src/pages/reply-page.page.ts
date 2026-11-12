import { randomUUID } from 'crypto';
import { expect, type APIResponse, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { queryDriversDb, querySingleValue, queryUnicodeText, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { randomCode, sha256Hex } from './reply-links.page';
import { BasePage } from './base.page';

export const REPLY_PAGE_MARKER = 'E2E-QC947-RP';

export const ANSWERED_CHANNEL = { Sms: 10, InApp: 20, Web: 30 } as const;

export const REPLY_PAGE_EN = {
  jobOffer: 'Job offer',
  statusCheck: 'Status check',
  options: { accept: 'Accept', cant: 'Decline', question: 'Comment', location: 'Share my location' },
  withdrawn: 'This message was withdrawn. You can still add a comment.',
  expired: 'This message can no longer be answered. You can still add a comment.',
  alreadyAnswered: 'This message has already been answered. You can still add a comment.',
  commentSent: 'Comment sent.',
  notFound: 'This link was not found or is no longer available.',
} as const;

export const REPLY_PAGE_ES = {
  jobOffer: 'Oferta de trabajo',
  options: { accept: 'Aceptar', cant: 'Rechazar', question: 'Comentario', location: 'Compartir mi ubicación' },
} as const;

export const LOCATION_REQUIRED = 'Allow location access to share your location.';

export const OPTED_OUT_ERROR = 'Opted out (STOP). Not sent until the Driver replies START.';

export type ReplyState = 'open' | 'expired' | 'withdrawn' | 'app';

export interface ReplySlotSpec {
  slot: string;
  type: 10 | 20;
  state: ReplyState;
}

export interface ReplySlot extends ReplySlotSpec {
  code: string;
  assignmentUuid: string;
  messageUuid: string;
  assignmentId: number;
  messageId: number;
}

export interface ReplySeedTarget {
  driverId: string;
  templateDriverId: string;
  hostUuid: string;
  newDriver?: { email: string; phone: string };
}

/** The Driver's public reply page in the host app (QC-947): http://<host>/m/{code}, rewritten to #/m/{code}, no shell, no sign-in. */
export class ReplyPage extends BasePage {
  protected readonly path = '/m/';
  readonly card: Locator;
  readonly title: Locator;
  readonly options: Locator;
  readonly answer: Locator;
  readonly closed: Locator;
  readonly addComment: Locator;
  readonly commentForm: Locator;
  readonly commentText: Locator;
  readonly send: Locator;
  readonly error: Locator;
  readonly notice: Locator;
  readonly notFound: Locator;
  readonly english: Locator;
  readonly spanish: Locator;

  constructor(page: Page) {
    super(page);
    this.card = page.getByTestId('reply-card');
    this.title = this.card.getByRole('heading', { level: 1 });
    this.options = page.getByTestId('reply-options');
    this.answer = page.getByTestId('reply-answer');
    this.closed = page.getByTestId('reply-closed');
    this.addComment = page.getByTestId('reply-add-comment');
    this.commentForm = page.getByTestId('reply-comment');
    this.commentText = this.commentForm.locator('#reply-comment-text');
    this.send = page.getByTestId('reply-send');
    this.error = page.getByTestId('reply-error');
    this.notice = page.getByTestId('reply-notice');
    this.notFound = page.getByTestId('reply-not-found');
    this.english = page.getByTestId('reply-lang-en');
    this.spanish = page.getByTestId('reply-lang-es');
  }

  async open(code: string): Promise<void> {
    await this.page.goto(`${this.path}${code}`);
    await expect(this.card.or(this.notFound)).toBeVisible({ timeout: 30_000 });
  }

  option(key: string): Locator {
    return this.page.locator(`.reply-option[data-option="${key}"]`);
  }

  async choose(key: string): Promise<void> {
    await this.option(key).click();
  }

  async comment(text: string): Promise<void> {
    if (await this.addComment.isVisible()) await this.addComment.click();
    await this.commentText.fill(text);
    await this.send.click();
  }

  async expectStandalone(code: string): Promise<void> {
    await expect(this.page).toHaveURL(`${env.appUrl}/#/m/${code}`);
    await expect(this.page.locator('app-sidebar')).toHaveCount(0);
    await expect(this.page.locator('app-header')).toHaveCount(0);
    await expect(this.page.locator('app-footer')).toHaveCount(0);
    await expect(this.page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');
  }

  async expectOptions(labels: string[]): Promise<void> {
    await expect(this.options.locator('.reply-option')).toHaveText(labels);
  }

  async expectAnswered(label: string, where: 'on the web' | 'by text' | 'in the app'): Promise<void> {
    await expect(this.answer).toHaveText(new RegExp(`^You replied ${label} ${where} at \\d{1,2}:\\d{2} (AM|PM)$`));
    await expect(this.options).toHaveCount(0);
  }
}

export function seedReplySlots(target: ReplySeedTarget, specs: ReplySlotSpec[]): Record<string, ReplySlot> {
  const slots = specs.map((s) => ({ ...s, code: randomCode(), assignmentUuid: randomUUID(), messageUuid: randomUUID(), assignmentId: 0, messageId: 0 }));
  const rows = slots.map((s) => [s.slot, s.type, sha256Hex(s.code), s.assignmentUuid, s.messageUuid, s.state].join(',')).join(';');
  const output = runSeedScript('reply-page-qc947.apply.sql', {
    DriverId: target.driverId,
    TemplateDriverId: target.templateDriverId,
    DriverEmail: target.newDriver?.email ?? '-',
    DriverPhone: target.newDriver?.phone ?? '-',
    Rows: rows,
  });
  for (const slot of slots) {
    const match = output.match(new RegExp(`SEED ${slot.slot} assignment=(\\d+);message=(\\d+)`));
    if (!match) throw new Error(`The QC-947 seed did not report slot ${slot.slot}:\n${output}`);
    slot.assignmentId = Number(match[1]);
    slot.messageId = Number(match[2]);
  }
  runDriversSeedScript('drivers-reply-page-qc947.apply.sql', {
    DriverUuid: target.driverId,
    TemplateDriverUuid: target.templateDriverId,
    HostUuid: target.hostUuid,
    Link: target.newDriver ? '1' : '0',
    Rows: rows,
  });
  return Object.fromEntries(slots.map((s) => [s.slot, s]));
}

export function removeReplySlots(driverUuid: string, driversWatermark: number, sidPrefix: string): void {
  const host = runSeedScript('reply-page-qc947.remove.sql', { SidPrefix: sidPrefix });
  const drivers = runDriversSeedScript('drivers-reply-page-qc947.remove.sql', { DriverUuid: driverUuid, AfterMessageId: String(driversWatermark) });
  if (!/REMOVED assignments=0;messages=0;users=0/.test(host)) throw new Error(`QC-947 host rows are left behind:\n${host}`);
  if (!/REMOVED assignments=0;messages=0;links=0/.test(drivers)) throw new Error(`QC-947 DRIVERS rows are left behind:\n${drivers}`);
}

export function driversHostUuid(): string {
  const uuid = queryDriversDb(
    `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = N'${env.hostName.replace(/'/g, "''")}' AND Active = 1`,
  );
  if (!uuid) throw new Error(`The host '${env.hostName}' (HOST_NAME) is not an active host in the DRIVERS database.`);
  return uuid;
}

export function driversMessageWatermark(): number {
  return Number(queryDriversDb('SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages'));
}

export interface LinkedDriver {
  id: string;
  name: string;
  phone: string;
}

/** An active host Driver with a phone and a truck assignment to copy, linked to this host in DRIVERS (so MessageAnswered lands). */
export function pickLinkedDriver(hostUuid: string): LinkedDriver {
  const linked = queryDriversDb(`SELECT STRING_AGG(CONCAT('''', LOWER(CONVERT(nvarchar(36), UserUUID)), ''''), ',') FROM app.DriverHostLinks
    WHERE HostUUID = '${hostUuid}' AND Active = 1 AND ISNULL(CreatedBy, '') <> N'e2e-qc947'`);
  if (!linked) throw new Error('QC-947 needs a Driver linked to this host in DRIVERS (app.DriverHostLinks).');
  const row = querySingleValue(`SELECT TOP 1 CONCAT(u.Id, '|', LTRIM(RTRIM(CONCAT(u.FirstName, ' ', u.LastName))), '|', u.PhoneNumber) FROM auth.Users u
    JOIN auth.UserToRoles r ON r.UserId = u.Id AND r.RoleName = N'Driver'
    WHERE u.IsActive = 1 AND ISNULL(u.PhoneNumber, '') <> '' AND LOWER(u.Id) IN (${linked})
      AND EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL
        AND ISNULL(a.Notes, N'') NOT LIKE N'E2E%')
    ORDER BY u.Id`);
  if (!row) throw new Error('QC-947 needs a linked Driver with a phone and a truck assignment to copy.');
  const [id, name, phone] = row.split('|');
  return { id, name, phone };
}

export interface HostLinkAnswer {
  option: string | null;
  channel: number | null;
  answerMessageId: number | null;
}

export function hostLinkAnswer(messageId: number): HostLinkAnswer {
  const row = querySingleValue(`SELECT CONCAT(ISNULL(AnsweredOption, '~'), '|', ISNULL(CAST(AnsweredChannel AS varchar(6)), '~'), '|',
    ISNULL(CAST(AnswerMessageID_FK AS varchar(12)), '~')) FROM app.MessageReplyLinks WHERE MessageID_FK = ${messageId}`);
  expect(row, `the reply link of message ${messageId}`).not.toBeNull();
  const [option, channel, answer] = row!.split('|');
  return { option: option === '~' ? null : option, channel: channel === '~' ? null : Number(channel), answerMessageId: answer === '~' ? null : Number(answer) };
}

export function assignmentStatusOf(assignmentId: number): number {
  return Number(querySingleValue(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignmentId}`));
}

export function repliesTo(messageId: number): { id: number; body: string | null; channel: number }[] {
  const ids = querySingleValue(`SELECT STRING_AGG(CONCAT(MessageID, ':', Channel), ',') WITHIN GROUP (ORDER BY MessageID)
    FROM app.Messages WHERE ReplyToMessageID_FK = ${messageId} AND Direction = 10`);
  return (ids ? ids.split(',') : []).map((pair) => {
    const [id, channel] = pair.split(':').map(Number);
    return { id, channel, body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`) };
  });
}

export interface StoredPing {
  count: number;
  lat: number;
  lon: number;
  isManual: number;
  deviceId: string;
}

export function sharedLocationOf(assignmentId: number): StoredPing {
  const row = querySingleValue(`SELECT CONCAT(COUNT(*), '|', MAX(CAST(Lat AS varchar(20))), '|', MAX(CAST(Lon AS varchar(20))), '|',
    MAX(CAST(IsManual AS int)), '|', MAX(DeviceID)) FROM app.TripGps WHERE OrderAssignmentID_FK = ${assignmentId}`);
  const [count, lat, lon, isManual, deviceId] = (row ?? '0||||').split('|');
  return { count: Number(count), lat: Number(lat), lon: Number(lon), isManual: Number(isManual), deviceId };
}

export interface DriversAnswer {
  responseCode: string | null;
  channel: string | null;
  answeredAt: string | null;
  answerMessageUuid: string | null;
}

export function driversAnswerOf(messageUuid: string): DriversAnswer {
  const row = queryDriversDb(`SELECT CONCAT(ISNULL(AnswerResponseCode, '~'), '|', ISNULL(AnswerChannel, '~'), '|',
    ISNULL(CONVERT(varchar(23), AnsweredAt, 121), '~'), '|', ISNULL(LOWER(CONVERT(nvarchar(36), AnswerMessageUUID)), '~'))
    FROM app.Messages WHERE MessageUUID = '${messageUuid}'`);
  expect(row, `the DRIVERS message ${messageUuid}`).not.toBeNull();
  const [responseCode, channel, answeredAt, answerMessageUuid] = row!.split('|').map((v) => (v === '~' ? null : v));
  return { responseCode, channel, answeredAt, answerMessageUuid };
}

export async function expectDriversAnswer(messageUuid: string, responseCode: string, channel: 'web' | 'sms'): Promise<void> {
  await expect
    .poll(() => driversAnswerOf(messageUuid).responseCode, { message: `MessageAnswered reaches DRIVERS for ${messageUuid}`, timeout: 30_000 })
    .toBe(responseCode);
  const answer = driversAnswerOf(messageUuid);
  expect(answer.channel).toBe(channel);
  expect(answer.answeredAt).not.toBeNull();
  expect(answer.answerMessageUuid).toMatch(/^[0-9a-f-]{36}$/);
}

export interface SmsOptOutRow {
  exists: boolean;
  optedOut: number;
  keyword: string | null;
  changedAt: string | null;
  updated: string | null;
}

export function smsOptOutOf(e164: string): SmsOptOutRow {
  const row = querySingleValue(`SELECT CONCAT(CAST(OptedOut AS int), '|', ISNULL(Keyword, '~'), '|', ISNULL(CONVERT(varchar(23), ChangedAt, 121), '~'), '|',
    ISNULL(CONVERT(varchar(23), Updated, 121), '~')) FROM app.SmsOptOuts WHERE PhoneNumber = '${e164}'`);
  if (!row) return { exists: false, optedOut: 0, keyword: null, changedAt: null, updated: null };
  const [optedOut, keyword, changedAt, updated] = row.split('|');
  const opt = (v: string) => (v === '~' ? null : v);
  return { exists: true, optedOut: Number(optedOut), keyword: opt(keyword), changedAt: opt(changedAt), updated: opt(updated) };
}

export function restoreSmsOptOut(e164: string, original: SmsOptOutRow): void {
  if (!original.exists) {
    querySingleValue(`DELETE app.SmsOptOuts WHERE PhoneNumber = '${e164}'`);
    return;
  }
  const text = (v: string | null) => (v === null ? 'NULL' : `'${v}'`);
  querySingleValue(`UPDATE app.SmsOptOuts SET OptedOut = ${original.optedOut}, Keyword = ${text(original.keyword)}, ChangedAt = ${text(original.changedAt)},
    Updated = ${text(original.updated)} WHERE PhoneNumber = '${e164}'`);
}

export interface DriversOptOut {
  smsOptedOut: number;
  changedAt: string | null;
  updated: string | null;
}

export function driversOptOutOf(driverUuid: string, hostUuid: string): DriversOptOut {
  const row = queryDriversDb(`SELECT CONCAT(CAST(SmsOptedOut AS int), '|', ISNULL(CONVERT(varchar(23), SmsOptOutChangedAt, 121), '~'), '|',
    CONVERT(varchar(23), Updated, 121)) FROM app.DriverHostLinks WHERE UserUUID = '${driverUuid}' AND HostUUID = '${hostUuid}'`);
  expect(row, `a DRIVERS link for ${driverUuid}`).not.toBeNull();
  const [optedOut, changedAt, updated] = row!.split('|');
  return { smsOptedOut: Number(optedOut), changedAt: changedAt === '~' ? null : changedAt, updated };
}

export function restoreDriversOptOut(driverUuid: string, hostUuid: string, original: DriversOptOut): void {
  const changedAt = original.changedAt === null ? 'NULL' : `'${original.changedAt}'`;
  queryDriversDb(`UPDATE app.DriverHostLinks SET SmsOptedOut = ${original.smsOptedOut}, SmsOptOutChangedAt = ${changedAt}, Updated = '${original.updated}'
    WHERE UserUUID = '${driverUuid}' AND HostUUID = '${hostUuid}'`);
}

export function latestDriversNotice(driverUuid: string, afterMessageId: number): string | null {
  const id = queryDriversDb(`SELECT TOP 1 MessageID FROM app.Messages WHERE DriverUserUUID = '${driverUuid}' AND MessageID > ${afterMessageId}
    AND MessageType = 50 ORDER BY MessageID DESC`);
  return id === null ? null : queryDriversDb(`SELECT MessageBody FROM app.Messages WHERE MessageID = ${id}`);
}

export function driversHostName(hostUuid: string): string {
  return queryDriversDb(`SELECT HostName FROM app.Hosts WHERE HostUUID = '${hostUuid}'`) ?? '';
}

export function hostNoticeFor(keywordMessageId: number): { body: string | null; messageType: number; ai: number; isActioned: number } | null {
  const row = querySingleValue(`SELECT TOP 1 CONCAT(MessageID, '|', MessageType, '|', ISNULL(AiClassification, -1), '|', CAST(IsActioned AS int))
    FROM app.Messages WHERE ReplyToMessageID_FK = ${keywordMessageId} AND MessageType = 50 ORDER BY MessageID DESC`);
  if (!row) return null;
  const [id, messageType, ai, isActioned] = row.split('|').map(Number);
  return { body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`), messageType, ai, isActioned };
}

export function smsRowByMarker(marker: string): { error: string | null; sid: string | null } | null {
  const row = querySingleValue(`SELECT TOP 1 CONCAT(ISNULL(TwilioError, '~'), '|', ISNULL(TwilioMessageSid, '~')) FROM app.Messages
    WHERE MessageBody LIKE N'%${marker}%' AND Direction = 20 ORDER BY MessageID DESC`);
  if (!row) return null;
  const [error, sid] = row.split('|');
  return { error: error === '~' ? null : error, sid: sid === '~' ? null : sid };
}

export interface DriverThreadMessage {
  messageUuid: string;
  answer: { responseCode: string; label: string; comment: string | null; channel: string; answeredAt: string; text: string } | null;
  replyRejected: boolean;
}

export async function threadOf(response: APIResponse): Promise<{ smsOptedOut: boolean; messages: DriverThreadMessage[] }> {
  expect(response.status(), await response.text()).toBe(200);
  const data = (await response.json()).data;
  return { smsOptedOut: data.smsOptedOut, messages: data.messages ?? [] };
}
