import * as fs from 'fs';
import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { queryDriversDb, querySingleValue, queryUnicodeText } from '@utils/localDb';
import { BasePage } from './base.page';

export const SMS_ROUTING_MARKER = 'e2e-qc930';

export const OFFER_DELIVERY = {
  app: "Goes to the Driver App. The Driver's own Text messages setting decides whether it is also texted.",
  textsOff: 'Not texted: Text messages are off for them.',
  textedTo: (phone: string) => `Texted to ${phone}.`,
} as const;

export const OFFER_HISTORY = {
  app: "Job offer message sent to the driver's Driver App; their own setting decides texts.",
  sms: 'Driver notified by SMS.',
  textsOff: 'Driver not texted: Text messages are off for them.',
} as const;

export const COMMS_REFUSAL = {
  textsOff: 'Text messages are off for that driver, so no SMS can be sent.',
  noAssignment: "That driver has no assignments, so a message can't reach the Driver App.",
} as const;

export const COPY_HINT = /^\s*\d+ offers? will be sent, to the driver or the Vendor's dispatch contact\./;

export const HOST_SMS_LOGGED = 'Dispatch SMS suppressed (no provider configured).';

/** Dispatch > Schedule (`#/dispatch/schedule`) and its Copy Schedule dialog: the "Notify drivers now" tick and its offer hint (QC-930). */
export class CopyScheduleDialogPage extends BasePage {
  protected readonly path = '/#/dispatch/schedule';
  readonly copyButton: Locator;
  readonly dialog: Locator;
  readonly notifyDrivers: Locator;
  readonly hints: Locator;
  readonly close: Locator;

  constructor(page: Page) {
    super(page);
    this.copyButton = page.getByRole('button', { name: 'Copy', exact: true });
    this.dialog = page.locator('app-copy-assignments-dialog');
    this.notifyDrivers = this.dialog.getByRole('checkbox', { name: 'Notify drivers now' });
    this.hints = this.dialog.locator('.copy-hint');
    this.close = this.dialog.getByRole('button', { name: 'Close' });
  }

  async open(date: string): Promise<void> {
    const board = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/dispatch\/board$/.test(new URL(r.url()).pathname));
    await this.page.goto(`${this.path}?date=${date}`);
    await this.page.reload();
    expect((await board).status(), 'GET dispatch/board').toBe(200);
    await this.copyButton.click();
    await expect(this.dialog).toBeVisible();
  }

  offerHint(): Locator {
    return this.hints.filter({ hasText: 'will be sent' });
  }

  retiredHint(): Locator {
    return this.hints.filter({ hasText: 'will be texted' });
  }
}

export interface SeededRouting {
  vendor: number;
  truckL: number;
  truckP: number;
  truckQ: number;
  order: number;
  edit: number;
}

export function parseRoutingSeed(output: string): SeededRouting {
  const match = output.match(/SEEDED vendor=(\d+);truckL=(\d+);truckP=(\d+);truckQ=(\d+);order=(\d+);edit=(\d+)/);
  if (!match) throw new Error(`The QC-930 host seed did not report its rows:\n${output}`);
  const [vendor, truckL, truckP, truckQ, order, edit] = match.slice(1).map(Number);
  return { vendor, truckL, truckP, truckQ, order, edit };
}

export function hostUserId(name: 'linked' | 'plain' | 'quiet'): string {
  const id = querySingleValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'e2e.qc930.${name}@quarryconnect.test')`);
  if (!id) throw new Error(`The QC-930 ${name} driver is not in the host database.`);
  return id;
}

export interface HostOfferMessage {
  id: number;
  uuid: string;
  channel: number;
  sid: string | null;
  sentAt: string | null;
  body: string | null;
  replyLinks: number;
}

/** The outbound dispatch messages (OrderNotify) of one host assignment, oldest first. */
export function offerMessagesOf(orderAssignmentId: number): HostOfferMessage[] {
  const rows =
    querySingleValue(`SELECT STRING_AGG(CONCAT(m.MessageID, '|', LOWER(CONVERT(nvarchar(36), m.MessageUUID)), '|', m.Channel, '|', ISNULL(m.TwilioMessageSid, '~'), '|',
      ISNULL(CONVERT(varchar(23), m.SentAt, 121), '~'), '|', l.Links), ';') WITHIN GROUP (ORDER BY m.MessageID)
    FROM app.Messages m OUTER APPLY (SELECT COUNT(*) AS Links FROM app.MessageReplyLinks x WHERE x.MessageID_FK = m.MessageID) l
    WHERE m.OrderAssignmentID_FK = ${orderAssignmentId} AND m.Direction = 20 AND m.MessageType = 10`);
  return (rows ? rows.split(';') : []).map((row) => {
    const [id, uuid, channel, sid, sentAt, links] = row.split('|');
    return {
      id: Number(id),
      uuid,
      channel: Number(channel),
      sid: sid === '~' ? null : sid,
      sentAt: sentAt === '~' ? null : sentAt,
      body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`),
      replyLinks: Number(links),
    };
  });
}

export function messagesOfDriver(driverUserId: string): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE DriverUserID_FK = N'${driverUserId}'`));
}

export function historyOf(orderAssignmentId: number): string[] {
  const rows = querySingleValue(`SELECT STRING_AGG(OrderAssignmentHistoryData, '||') WITHIN GROUP (ORDER BY OrderAssignmentHistoryID)
    FROM app.OrderAssignmentHistory WHERE OrderAssignmentID_FK = ${orderAssignmentId}`);
  return rows ? rows.split('||') : [];
}

export function assignmentUuidOf(orderAssignmentId: number): string {
  return (
    querySingleValue(`SELECT LOWER(CONVERT(nvarchar(36), OrderAssignmentUUID)) FROM app.OrderAssignments WHERE OrderAssignmentID = ${orderAssignmentId}`) ?? ''
  );
}

/** The host's own UUID in DRIVERS (EnvironmentSetting Messaging:HostUuid), the one its JobOffered / MessageSent events carry. */
export function hostMessagingUuid(): string {
  const uuid = querySingleValue(`SELECT TOP 1 LOWER(PropertyValue) FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND PropertyName = N'HostUuid'`);
  if (!uuid || queryDriversDb(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${uuid}' AND Active = 1`) !== '1') {
    throw new Error(`The host's Messaging:HostUuid (${uuid}) is not an active host in the DRIVERS database.`);
  }
  return uuid;
}

export function hostTwilioFromNumber(): string {
  return querySingleValue(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'Twilio' AND PropertyName = N'FromPhoneNumber'`) ?? '';
}

export interface HostUserSetting {
  exists: boolean;
  notifyBySms: number | null;
  contactVersion: number | null;
  mobilePhone: string | null;
  languageCode: string | null;
  notifyByPush: number | null;
}

export function hostUserSettingOf(userId: string): HostUserSetting {
  const row = querySingleValue(`SELECT TOP 1 CONCAT(ISNULL(CAST(NotifyBySms AS varchar(2)), '~'), '|', ISNULL(CAST(ContactVersion AS varchar(12)), '~'), '|',
      ISNULL(MobilePhone, '~'), '|', ISNULL(LanguageCode, '~'), '|', ISNULL(CAST(NotifyByPush AS varchar(2)), '~'))
    FROM app.UserSettings WHERE UserID_FK = N'${userId}' AND Active = 1`);
  if (!row) return { exists: false, notifyBySms: null, contactVersion: null, mobilePhone: null, languageCode: null, notifyByPush: null };
  const [sms, version, phone, language, push] = row.split('|').map((v) => (v === '~' ? null : v));
  return {
    exists: true,
    notifyBySms: sms === null ? null : Number(sms),
    contactVersion: version === null ? null : Number(version),
    mobilePhone: phone,
    languageCode: language,
    notifyByPush: push === null ? null : Number(push),
  };
}

export function setHostLanguageAndPush(userId: string, languageCode: string | null, notifyByPush: 0 | 1): void {
  querySingleValue(`UPDATE app.UserSettings SET LanguageCode = ${languageCode === null ? 'NULL' : `N'${languageCode}'`}, NotifyByPush = ${notifyByPush}
    WHERE UserID_FK = N'${userId}' AND Active = 1`);
}

export function hostPhoneOf(userId: string): string | null {
  return querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = N'${userId}'`);
}

export interface DriversTextSetting {
  notifyBySms: number | null;
  contactVersion: number | null;
}

export function driversTextSettingOf(userUuid: string): DriversTextSetting {
  const row = queryDriversDb(`SELECT CONCAT(ISNULL(CAST(s.NotifyBySms AS varchar(2)), '~'), '|', ISNULL(CAST(s.ContactVersion AS varchar(12)), '~'))
    FROM app.DriverSettings s JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID = '${userUuid}' AND s.Active = 1`);
  expect(row, `DRIVERS DriverSettings of ${userUuid}`).not.toBeNull();
  const [sms, version] = row!.split('|');
  return { notifyBySms: sms === '~' ? null : Number(sms), contactVersion: version === '~' ? null : Number(version) };
}

export function setDriversTextSetting(userUuid: string, notifyBySms: 0 | 1 | null): void {
  queryDriversDb(`UPDATE s SET NotifyBySms = ${notifyBySms === null ? 'NULL' : notifyBySms} FROM app.DriverSettings s
    JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID = '${userUuid}'`);
}

export function driversPhoneOf(userUuid: string): string | null {
  return queryDriversDb(`SELECT PhoneNumber FROM auth.Users WHERE UserUUID = '${userUuid}'`);
}

export function setDriversPhone(userUuid: string, phone: string | null): void {
  queryDriversDb(`UPDATE auth.Users SET PhoneNumber = ${phone === null ? 'NULL' : `N'${phone}'`} WHERE UserUUID = '${userUuid}'`);
}

export function driversAssignmentExists(orderAssignmentUuid: string): boolean {
  return queryDriversDb(`SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${orderAssignmentUuid}'`) === '1';
}

export interface DriversOfferMessage {
  messageUuid: string;
  messageType: number;
  body: string;
}

/** The dispatch messages DRIVERS holds on one assignment. */
export function driversMessagesOn(orderAssignmentUuid: string): DriversOfferMessage[] {
  const rows =
    queryDriversDb(`SELECT STRING_AGG(CONCAT(LOWER(CONVERT(nvarchar(36), MessageUUID)), '|', MessageType, '|', MessageBody), '~~') WITHIN GROUP (ORDER BY MessageID)
    FROM app.Messages WHERE OrderAssignmentUUID = '${orderAssignmentUuid}' AND IsFromDispatch = 1`);
  return (rows ? rows.split('~~') : []).map((row) => {
    const [messageUuid, messageType, ...body] = row.split('|');
    return { messageUuid, messageType: Number(messageType), body: body.join('|') };
  });
}

export function driversMessageExists(messageUuid: string): boolean {
  return queryDriversDb(`SELECT COUNT(*) FROM app.Messages WHERE MessageUUID = '${messageUuid}'`) === '1';
}

/** A console log the stack writes to a file (HOST_API_LOG, DRIVERS_API_LOG): the byte offset now, and the text written since. */
export class ServiceLog {
  constructor(private readonly file: string | null) {}

  get available(): boolean {
    return !!this.file && fs.existsSync(this.file);
  }

  mark(): number {
    return this.available ? fs.statSync(this.file!).size : 0;
  }

  since(mark: number): string {
    return this.available ? fs.readFileSync(this.file!).subarray(mark).toString('utf8') : '';
  }

  async expectLine(mark: number, pattern: RegExp, message: string): Promise<void> {
    await expect.poll(() => pattern.test(this.since(mark)), { message, timeout: 30_000 }).toBe(true);
  }
}

export const hostLog = new ServiceLog(env.hostApiLog);
export const driversLog = new ServiceLog(env.driversApiLog);

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
