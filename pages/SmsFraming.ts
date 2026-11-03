import { expect, type Page } from '@playwright/test';
import { querySingleValue, queryUnicodeText } from '../fixtures/localDb';

export const SMS_OPT_OUT_LINE = 'Reply STOP to opt out';

export const SMS_SINGLE_SEGMENT = 160;

const DEFAULT_HOST_NAME_AFTER_DAYS = 30;

export function hostName(): string {
  const name = querySingleValue(`SELECT LTRIM(RTRIM(o.OrganisationName)) FROM auth.Organisations o
    WHERE o.OrganisationId = (SELECT TOP 1 TRY_CAST(PropertyValue AS int) FROM app.EnvironmentSetting WHERE PropertyName = 'HostOrganisationId')`);
  if (!name) throw new Error('The host organisation (EnvironmentSetting HostOrganisationId) has no OrganisationName.');
  return name;
}

export function hostNameAfterDays(): number {
  const value = Number(querySingleValue(
    `SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = 'DispatchComms' AND PropertyName = 'HostNameAfterDays'`,
  ));
  return Number.isFinite(value) && value >= 1 ? value : DEFAULT_HOST_NAME_AFTER_DAYS;
}

export function toE164(phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, '');
  if (phoneNumber.trim().startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return `+${digits}`;
}

export function framedSms(host: string, body: string): string {
  const prefixed = body.toLowerCase().startsWith(`${host}:`.toLowerCase()) ? body : `${host}: ${body}`;
  return `${prefixed}\n${SMS_OPT_OUT_LINE}`;
}

export function framingBudget(host: string): number {
  return SMS_SINGLE_SEGMENT - (host.length + 2) - SMS_OPT_OUT_LINE.length - 1;
}

export function isFirstTextTo(phoneNumber: string): boolean {
  const seconds = querySingleValue(`SELECT DATEDIFF(SECOND, MAX(SentAt), GETUTCDATE()) FROM app.Messages
    WHERE Active = 1 AND PhoneNumber = N'${toE164(phoneNumber)}' AND Direction = 20 AND Channel = 10 AND SentAt IS NOT NULL`);
  return seconds === null || Number(seconds) >= hostNameAfterDays() * 86_400;
}

export function expectedSmsBody(phoneNumber: string, body: string): string {
  return isFirstTextTo(phoneNumber) ? framedSms(hostName(), body) : body;
}

export interface StoredMessage {
  id: number;
  body: string | null;
  channel: number;
  messageType: number;
  assignment: number | null;
  sid: string | null;
  phone: string | null;
}

export function storedMessageById(id: number): StoredMessage {
  const assignment = querySingleValue(`SELECT OrderAssignmentID_FK FROM app.Messages WHERE MessageID = ${id}`);
  return {
    id,
    body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`),
    channel: Number(querySingleValue(`SELECT Channel FROM app.Messages WHERE MessageID = ${id}`)),
    messageType: Number(querySingleValue(`SELECT MessageType FROM app.Messages WHERE MessageID = ${id}`)),
    assignment: assignment === null ? null : Number(assignment),
    sid: querySingleValue(`SELECT TwilioMessageSid FROM app.Messages WHERE MessageID = ${id}`),
    phone: querySingleValue(`SELECT PhoneNumber FROM app.Messages WHERE MessageID = ${id}`),
  };
}

export function latestOutboundId(driverUserId: string, afterMessageId: number): number | null {
  const id = querySingleValue(`SELECT TOP 1 MessageID FROM app.Messages
    WHERE DriverUserID_FK = '${driverUserId}' AND Direction = 20 AND MessageID > ${afterMessageId} ORDER BY MessageID DESC`);
  return id === null ? null : Number(id);
}

export function storedMessageContaining(marker: string): StoredMessage {
  const id = Number(querySingleValue(
    `SELECT TOP 1 MessageID FROM app.Messages WHERE MessageBody LIKE N'%${marker.replace(/'/g, "''")}%' ORDER BY MessageID DESC`,
  ));
  expect(id, `a message stored with ${marker} in its body`).toBeGreaterThan(0);
  return storedMessageById(id);
}

export function backdateSmsSentTo(phoneNumber: string, afterMessageId: number, days: number): number {
  return Number(querySingleValue(`UPDATE app.Messages SET SentAt = DATEADD(DAY, -${days}, GETUTCDATE())
    WHERE MessageID > ${afterMessageId} AND PhoneNumber = N'${toE164(phoneNumber)}' AND Direction = 20 AND Channel = 10 AND SentAt IS NOT NULL;
    SELECT @@ROWCOUNT`));
}

export function jobDocName(orderAssignmentId: number): string {
  const jobId = Number(querySingleValue(`SELECT o.JobID_FK FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    WHERE a.OrderAssignmentID = ${orderAssignmentId}`));
  expect(jobId, `the job of assignment ${orderAssignmentId}`).toBeGreaterThan(0);
  return `JOB${String(jobId).padStart(4, '0')}`;
}

export interface SmsPreviewQuery {
  orderId: number;
  driverUserId?: string;
  timeWindowStart?: string;
  loadsAssigned?: number;
  fulfillmentType: number;
}

export interface SmsPreview {
  status: number;
  body: string | null;
  canSend: boolean;
  cannotSendReason: string | null;
}

export class SmsPreviewApi {
  constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  async preview(query: SmsPreviewQuery): Promise<SmsPreview> {
    const params = new URLSearchParams({ orderId: String(query.orderId), fulfillmentType: String(query.fulfillmentType) });
    if (query.driverUserId) params.set('driverUserId', query.driverUserId);
    if (query.timeWindowStart) params.set('timeWindowStart', query.timeWindowStart);
    if (query.loadsAssigned !== undefined) params.set('loadsAssigned', String(query.loadsAssigned));

    const { status, text } = await this.page.evaluate(async (url) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` } });
      return { status: response.status, text: await response.text() };
    }, `${this.apiUrl}/api/dispatch/sms-preview?${params}`);

    expect(status, `GET sms-preview ${text}`).toBe(200);
    const parsed = JSON.parse(text);
    const data = parsed?.data ?? parsed;
    return { status, body: data.body ?? null, canSend: data.canSend, cannotSendReason: data.cannotSendReason ?? null };
  }
}
