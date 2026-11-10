import { createHash, randomInt } from 'crypto';
import { expect, request as playwrightRequest, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { querySingleValue, queryUnicodeText } from '@utils/localDb';

export const REPLY_LINK_TOKEN = '{ReplyLink}';

export const REPLY_LINK_CODE_LENGTH = 10;

export const REPLY_LINK_DEFAULT_BASE_URL = 'https://drivers.quarryconnect.com/m/';

export const REPLY_LINK_ORIGIN = 'https://drivers.quarryconnect.com';

export const REPLY_LINK_URL = /https:\/\/drivers\.quarryconnect\.com\/m\/([0-9A-Za-z]{10})/;

export const LINK_NOT_FOUND = 'This link was not found or is no longer available.';

export const TOO_MANY_REQUESTS = 'Too many requests for this link. Try again shortly.';

export const MESSAGE_TYPE = { OrderNotify: 10, StatusCheck: 20, Manual: 30, StatusReply: 40 } as const;

export const DIRECTION = { Inbound: 10, Outbound: 20 } as const;

export const AI = { Late: 10, Issue: 20, Noted: 40, Unknown: 50, CantMakeIt: 60 } as const;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001BÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);

const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

export function replyLinkBaseUrl(): string {
  const configured = querySingleValue(
    `SELECT TOP 1 LTRIM(RTRIM(PropertyValue)) FROM app.EnvironmentSetting WHERE GroupName = 'DispatchComms' AND PropertyName = 'ReplyLinkBaseUrl'`,
  );
  return configured || REPLY_LINK_DEFAULT_BASE_URL;
}

export function replyLinkReadOnlyDays(): number {
  const value = Number(
    querySingleValue(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = 'DispatchComms' AND PropertyName = 'ReplyLinkReadOnlyDays'`),
  );
  return Number.isFinite(value) && value >= 0 ? value : 7;
}

export function replyLinkUrl(code: string): string {
  const base = replyLinkBaseUrl();
  return base.endsWith('/') ? `${base}${code}` : `${base}/${code}`;
}

export function codeIn(body: string | null): string {
  const match = (body ?? '').match(REPLY_LINK_URL);
  expect(match, `a reply link in the stored SMS body:\n${body}`).not.toBeNull();
  return match![1];
}

export function sha256Hex(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function randomCode(): string {
  return Array.from({ length: REPLY_LINK_CODE_LENGTH }, () => BASE62[randomInt(BASE62.length)]).join('');
}

export function gsm7Units(body: string): number | null {
  let units = 0;
  for (const ch of body) {
    if (GSM7_BASIC.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else return null;
  }
  return units;
}

export interface StoredReplyLink {
  id: number;
  messageId: number;
  codeHash: string;
  expiresAt: string;
  answeredOption: string | null;
  answeredAt: string | null;
  answerMessageId: number | null;
  updated: string;
  active: number;
}

export function replyLinksOf(messageId: number): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.MessageReplyLinks WHERE MessageID_FK = ${messageId}`));
}

export function replyLinkOf(messageId: number): StoredReplyLink {
  const row = querySingleValue(`SELECT CONCAT(MessageReplyLinkID, '|', MessageID_FK, '|', CodeHash, '|',
      CONVERT(varchar(23), ExpiresAt, 121), '|', ISNULL(AnsweredOption, '~'), '|', ISNULL(CONVERT(varchar(23), AnsweredAt, 121), '~'), '|',
      ISNULL(CAST(AnswerMessageID_FK AS varchar(12)), '~'), '|', CONVERT(varchar(23), Updated, 121), '|', Active)
    FROM app.MessageReplyLinks WHERE MessageID_FK = ${messageId}`);
  expect(row, `a MessageReplyLinks row for message ${messageId}`).not.toBeNull();
  const [id, message, hash, expiresAt, option, answeredAt, answer, updated, active] = row!.split('|');
  const opt = (v: string) => (v === '~' ? null : v);
  return {
    id: Number(id),
    messageId: Number(message),
    codeHash: hash,
    expiresAt,
    answeredOption: opt(option),
    answeredAt: opt(answeredAt),
    answerMessageId: answer === '~' ? null : Number(answer),
    updated,
    active: Number(active),
  };
}

export function rowsHoldingText(text: string): number {
  const safe = text.replace(/'/g, "''");
  return Number(
    querySingleValue(`SELECT COUNT(*) FROM app.MessageReplyLinks
    WHERE CONCAT(MessageReplyLinkID, '|', MessageID_FK, '|', CodeHash, '|', AnsweredOption, '|', AnswerMessageID_FK) COLLATE Latin1_General_CS_AS LIKE '%${safe}%'`),
  );
}

export function setReplyLinkExpiry(messageId: number, minutesFromNow: number): void {
  querySingleValue(`UPDATE app.MessageReplyLinks SET ExpiresAt = DATEADD(MINUTE, ${minutesFromNow}, GETUTCDATE()) WHERE MessageID_FK = ${messageId}`);
}

export function expectedExpiryUtc(appDayOffset: number): string {
  return (
    querySingleValue(`SELECT CONVERT(varchar(23), CAST(CAST(DATEADD(DAY, ${appDayOffset + 1},
      CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)) AS datetime) AT TIME ZONE 'Central Standard Time' AT TIME ZONE 'UTC' AS datetime), 121)`) ??
    ''
  );
}

export interface StoredMessageRow {
  id: number;
  body: string | null;
  direction: number;
  messageType: number;
  channel: number;
  assignment: number | null;
  replyTo: number | null;
  ai: number | null;
  isActioned: number;
  sid: string | null;
}

export function messageRow(id: number): StoredMessageRow {
  const row = querySingleValue(`SELECT CONCAT(Direction, '|', MessageType, '|', Channel, '|', ISNULL(CAST(OrderAssignmentID_FK AS varchar(12)), '~'), '|',
      ISNULL(CAST(ReplyToMessageID_FK AS varchar(12)), '~'), '|', ISNULL(CAST(AiClassification AS varchar(6)), '~'), '|', CAST(IsActioned AS int), '|',
      ISNULL(TwilioMessageSid, '~')) FROM app.Messages WHERE MessageID = ${id}`);
  expect(row, `message ${id}`).not.toBeNull();
  const [direction, type, channel, assignment, replyTo, ai, actioned, sid] = row!.split('|');
  const num = (v: string) => (v === '~' ? null : Number(v));
  return {
    id,
    body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`),
    direction: Number(direction),
    messageType: Number(type),
    channel: Number(channel),
    assignment: num(assignment),
    replyTo: num(replyTo),
    ai: num(ai),
    isActioned: Number(actioned),
    sid: sid === '~' ? null : sid,
  };
}

export function latestOutbound(driverUserId: string, afterMessageId: number, messageType: number): number | null {
  const id = querySingleValue(`SELECT TOP 1 MessageID FROM app.Messages WHERE DriverUserID_FK = '${driverUserId}'
    AND Direction = ${DIRECTION.Outbound} AND MessageType = ${messageType} AND MessageID > ${afterMessageId} ORDER BY MessageID DESC`);
  return id === null ? null : Number(id);
}

export function linkReplies(smsMessageId: number): number[] {
  const ids = querySingleValue(`SELECT STRING_AGG(CAST(MessageID AS varchar(12)), ',') WITHIN GROUP (ORDER BY MessageID)
    FROM app.Messages WHERE ReplyToMessageID_FK = ${smsMessageId} AND Direction = ${DIRECTION.Inbound}`);
  return ids ? ids.split(',').map(Number) : [];
}

export function dispatcherNoteOf(messageId: number): string | null {
  return queryUnicodeText('DispatcherNote', `app.MessageReplyLinks WHERE MessageID_FK = ${messageId}`);
}

export function asDispatcherDraft(storedBody: string, code: string): string {
  return storedBody.split(replyLinkUrl(code)).join(REPLY_LINK_TOKEN);
}

export function driverPhone(driverUserId: string): string {
  const phone = querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = '${driverUserId}'`);
  expect(phone, `a phone number for driver ${driverUserId}`).toBeTruthy();
  return phone!;
}

export function inboundBySid(sid: string): number | null {
  const id = querySingleValue(`SELECT MessageID FROM app.Messages WHERE TwilioMessageSid = '${sid}' AND Direction = ${DIRECTION.Inbound}`);
  return id === null ? null : Number(id);
}

export function removeInboundBySid(sids: string[]): number {
  if (sids.length === 0) return 0;
  const list = sids.map((sid) => `'${sid.replace(/'/g, "''")}'`).join(', ');
  querySingleValue(`SET NOCOUNT ON;
    DELETE app.DriverMirrorChanges WHERE MessageID_FK IN (SELECT MessageID FROM app.Messages WHERE TwilioMessageSid IN (${list}));
    DELETE app.Messages WHERE TwilioMessageSid IN (${list});`);
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE TwilioMessageSid IN (${list})`));
}

export interface LinkOption {
  key: string;
  label: string;
  needsComment: boolean;
}

export interface ReplyLinkView {
  kind: string;
  state: 'open' | 'expired' | 'withdrawn';
  host: { name: string | null; logoUrl: string | null };
  sentAt: string;
  job: { number: string | null; from: string | null; to: string | null; start: string | null; loads: number | null } | null;
  text: string;
  options: LinkOption[];
  reply: { option: string; label: string; at: string; comment: string | null } | null;
}

export interface LinkAnswer {
  status: number;
  text: string;
  headers: Record<string, string>;
  view: ReplyLinkView | null;
  errors: string[];
}

export class ReplyLinkApi {
  private constructor(private readonly context: APIRequestContext) {}

  static async open(): Promise<ReplyLinkApi> {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
    return new ReplyLinkApi(
      await playwrightRequest.newContext({
        baseURL: env.appApiUrl,
        ignoreHTTPSErrors: true,
        storageState: { cookies: [], origins: [] },
      }),
    );
  }

  async close(): Promise<void> {
    await this.context.dispose();
  }

  get(code: string): Promise<LinkAnswer> {
    return this.withRetry(() => this.context.get(`/api/m/${encodeURIComponent(code)}`));
  }

  reply(code: string, body: { option?: string | null; comment?: string | null }): Promise<LinkAnswer> {
    return this.withRetry(() => this.context.post(`/api/m/${encodeURIComponent(code)}/reply`, { data: body }));
  }

  async replyOnce(code: string, body: { option?: string | null; comment?: string | null }): Promise<LinkAnswer> {
    return ReplyLinkApi.read(await this.context.post(`/api/m/${encodeURIComponent(code)}/reply`, { data: body }));
  }

  async preflight(code: string, origin: string): Promise<{ status: number; headers: Record<string, string> }> {
    const response = await this.context.fetch(`/api/m/${encodeURIComponent(code)}/reply`, {
      method: 'OPTIONS',
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    return { status: response.status(), headers: response.headers() };
  }

  private async withRetry(send: () => Promise<import('@playwright/test').APIResponse>): Promise<LinkAnswer> {
    let answer = await ReplyLinkApi.read(await send());
    if (answer.status === 429) {
      const wait = Math.min(Number(answer.headers['retry-after'] ?? '60') || 60, 65);
      await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
      answer = await ReplyLinkApi.read(await send());
    }
    return answer;
  }

  private static async read(response: import('@playwright/test').APIResponse): Promise<LinkAnswer> {
    const text = await response.text();
    let view: ReplyLinkView | null = null;
    let errors: string[] = [];
    try {
      const parsed = JSON.parse(text);
      view = parsed?.data && typeof parsed.data === 'object' ? parsed.data : null;
      errors = Array.isArray(parsed?.errors) ? parsed.errors : [];
    } catch {
      view = null;
    }
    return { status: response.status(), text, headers: response.headers(), view, errors };
  }
}

export class InboundSmsApi {
  private constructor(private readonly context: APIRequestContext) {}

  static async open(): Promise<InboundSmsApi> {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
    return new InboundSmsApi(
      await playwrightRequest.newContext({ baseURL: env.appApiUrl, ignoreHTTPSErrors: true, storageState: { cookies: [], origins: [] } }),
    );
  }

  async close(): Promise<void> {
    await this.context.dispose();
  }

  async receive(sid: string, from: string, body: string): Promise<number> {
    const response = await this.context.post('/api/dispatch/messages/inbound', {
      form: { MessageSid: sid, From: from, To: '+15005550006', Body: body },
    });
    return response.status();
  }
}

export interface NotifyAnswer {
  status: number;
  text: string;
}

export class AssignmentNotifyApi {
  constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  async ready(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }

  async notify(orderAssignmentId: number, smsBody: string | null = null): Promise<NotifyAnswer> {
    const current = await this.call('GET', `/api/assignment/${orderAssignmentId}`);
    expect(current.status, `GET assignment ${orderAssignmentId} ${current.text}`).toBe(200);
    const model = JSON.parse(current.text).data;
    const body = { ...model, status: null, histories: [], sendSms: true, smsBody };
    return this.call('PUT', `/api/assignment/${orderAssignmentId}`, body);
  }

  private async call(method: string, path: string, body?: unknown): Promise<NotifyAnswer> {
    return this.page.evaluate(
      async ({ url, method, body }) => {
        const response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      },
      { url: `${this.apiUrl}${path}`, method, body },
    );
  }
}

export class ReplyLinkThread {
  constructor(private readonly page: Page) {}

  channelTag(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId} .msg-channel`);
  }

  channelIcon(messageId: number): Locator {
    return this.channelTag(messageId).locator('mat-icon');
  }

  tooltip(): Locator {
    return this.page.locator('.mat-mdc-tooltip');
  }
}
