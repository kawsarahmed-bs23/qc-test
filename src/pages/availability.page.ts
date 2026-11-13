import * as net from 'net';
import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { queryDriversDb, querySingleValue, runDriversSeedScript, runSeedScript } from '@utils/localDb';
import { AssignDialogDispatchPage } from './dispatch-contact.page';
import { randomCode, sha256Hex } from './reply-links.page';
import { ReplyPage } from './reply-page.page';
import { BasePage } from './base.page';

export type AvailabilityPeriod = 'today' | 'tomorrow' | 'next-week';

export const AVAILABILITY_TYPE = { today: 60, tomorrow: 70, 'next-week': 80 } as const;

export const AVAILABILITY_TAG = { today: 'Availability today', tomorrow: 'Availability tomorrow', 'next-week': 'Availability next week' } as const;

export const AVAILABILITY_QUESTION = {
  today: 'Are you available for work today?',
  tomorrow: 'Are you available for work tomorrow?',
  'next-week': 'Are you available for work next week?',
} as const;

export const ASK_SENT = 'Availability question sent.';

export const AVAILABILITY_TITLE = 'Availability';

export const DRIVER_THAT_CAN_BE_ASKED_PHONE = '5125551003';

export const SEEDED_VENDOR = 'Riham Vendor';

export interface AvailabilityDrivers {
  askedId: string;
  askedTruckId: number;
  linkedId: string;
  linkedUuid: string;
}

export interface AvailabilitySlot {
  slot: string;
  type: number;
  dayOffset: number;
  state: 'open' | 'yes' | 'no' | 'days';
  code: string;
  messageId: number;
}

export interface AvailabilityWatermarks {
  host: number;
  drivers: number;
}

export function appDay(offsetDays = 0): Date {
  const zone = env.appTimeZone ?? 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const [year, month, day] = parts.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + offsetDays));
}

export function isoDay(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function usDay(day: Date): string {
  return `${day.getUTCMonth() + 1}/${day.getUTCDate()}/${day.getUTCFullYear()}`;
}

export function nextMondayOffset(): number {
  const ahead = (1 - appDay().getUTCDay() + 7) % 7;
  return ahead === 0 ? 7 : ahead;
}

export function pickDrivers(): AvailabilityDrivers {
  const askedId = querySingleValue(
    `SELECT TOP 1 Id FROM auth.Users WHERE PhoneNumber = '${DRIVER_THAT_CAN_BE_ASKED_PHONE}' AND IsActive = 1 AND UserUUID IS NOT NULL`,
  );
  if (!askedId) throw new Error(`QC-931 needs the active Driver with phone ${DRIVER_THAT_CAN_BE_ASKED_PHONE} (a Driver App driver).`);
  const askedTruckId = Number(querySingleValue(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = '${askedId}'`));
  const linked = queryDriversDb(
    `SELECT STRING_AGG(CONCAT('''', LOWER(CONVERT(nvarchar(36), UserUUID)), ''''), ',') FROM app.DriverHostLinks WHERE Active = 1 AND UserUUID <> '${askedId}'`,
  );
  if (!linked) throw new Error('QC-931 needs a second Driver linked to this host in DRIVERS (app.DriverHostLinks).');
  const row = querySingleValue(
    `SELECT TOP 1 CONCAT(Id, '|', LOWER(CONVERT(nvarchar(36), UserUUID))) FROM auth.Users WHERE IsActive = 1 AND LOWER(CONVERT(nvarchar(36), UserUUID)) IN (${linked}) ORDER BY Id`,
  );
  if (!row) throw new Error('No Driver linked in DRIVERS is an active host user.');
  const [linkedId, linkedUuid] = row.split('|');
  return { askedId, askedTruckId, linkedId, linkedUuid };
}

export function watermarks(): AvailabilityWatermarks {
  return {
    host: Number(querySingleValue('SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages')),
    drivers: Number(queryDriversDb('SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages')),
  };
}

export interface SlotSpec {
  slot: string;
  period: AvailabilityPeriod;
  dayOffset: number;
  state: AvailabilitySlot['state'];
}

export function seedAvailability(driverId: string, specs: SlotSpec[], orderDays: number): { slots: Record<string, AvailabilitySlot>; orderId: number | null } {
  const slots = specs.map((s) => ({
    slot: s.slot,
    type: AVAILABILITY_TYPE[s.period],
    dayOffset: s.dayOffset,
    state: s.state,
    code: randomCode(),
    messageId: 0,
  }));
  const rows = slots.map((s) => [s.slot, s.type, sha256Hex(s.code), s.dayOffset, s.state].join(',')).join(';');
  const output = runSeedScript('host-qc931.apply.sql', { DriverId: driverId, Rows: rows, OrderDays: String(orderDays) });
  for (const slot of slots) {
    const match = output.match(new RegExp(`SEED ${slot.slot} message=(\\d+)`));
    if (!match) throw new Error(`The QC-931 seed did not report slot ${slot.slot}:\n${output}`);
    slot.messageId = Number(match[1]);
  }
  const order = output.match(/ORDER (\d+)/);
  return { slots: Object.fromEntries(slots.map((s) => [s.slot, s])), orderId: order ? Number(order[1]) : null };
}

export function removeAvailability(driverIds: string[], driverUuids: string[], marks: AvailabilityWatermarks): void {
  const host = runSeedScript('host-qc931.remove.sql', { DriverIds: driverIds.join(','), AfterMessageId: String(marks.host) });
  const drivers = runDriversSeedScript('drivers-qc931.remove.sql', { DriverIds: driverUuids.join(','), AfterMessageId: String(marks.drivers) });
  if (!/REMOVED messages=0;links=0;orders=0;assignments=0/.test(host)) throw new Error(`QC-931 host rows are left behind:\n${host}`);
  if (!/REMOVED messages=0/.test(drivers)) throw new Error(`QC-931 DRIVERS rows are left behind:\n${drivers}`);
}

export interface StoredAsk {
  id: number;
  type: number;
  channel: number;
  direction: number;
  body: string;
  availabilityDate: string | null;
  hasReplyLink: boolean;
}

export function askSince(driverId: string, afterMessageId: number, type: number): StoredAsk | null {
  const id = querySingleValue(
    `SELECT TOP 1 MessageID FROM app.Messages WHERE DriverUserID_FK = '${driverId}' AND MessageID > ${afterMessageId} AND MessageType = ${type} AND Direction = 20 ORDER BY MessageID DESC`,
  );
  if (!id) return null;
  const row = querySingleValue(
    `SELECT CONCAT(Channel, '|', Direction, '|', ISNULL(CONVERT(varchar(10), AvailabilityDate, 23), '~'), '|', (SELECT COUNT(*) FROM app.MessageReplyLinks WHERE MessageID_FK = ${id})) FROM app.Messages WHERE MessageID = ${id}`,
  )!;
  const [channel, direction, date, links] = row.split('|');
  const body = querySingleValue(`SELECT REPLACE(REPLACE(MessageBody, CHAR(13), ''), CHAR(10), ' / ') FROM app.Messages WHERE MessageID = ${id}`) ?? '';
  return {
    id: Number(id),
    type,
    channel: Number(channel),
    direction: Number(direction),
    body,
    availabilityDate: date === '~' ? null : date,
    hasReplyLink: links !== '0',
  };
}

export interface StoredAnswer {
  answerId: number | null;
  option: string | null;
  channel: number | null;
  answerBody: string | null;
}

export function answerOf(questionId: number): StoredAnswer {
  const row = querySingleValue(
    `SELECT CONCAT(ISNULL(CAST(l.AnswerMessageID_FK AS varchar(12)), '~'), '|', ISNULL(l.AnsweredOption, '~'), '|', ISNULL(CAST(l.AnsweredChannel AS varchar(5)), '~'), '|', ISNULL(m.MessageBody, '~'))
     FROM app.MessageReplyLinks l LEFT JOIN app.Messages m ON m.MessageID = l.AnswerMessageID_FK WHERE l.MessageID_FK = ${questionId}`,
  );
  expect(row, `the reply link of message ${questionId}`).not.toBeNull();
  const [answerId, option, channel, body] = row!.split('|').map((v) => (v === '~' ? null : v));
  return { answerId: answerId === null ? null : Number(answerId), option, channel: channel === null ? null : Number(channel), answerBody: body };
}

export interface DriversGeneralMessage {
  id: number;
  type: number;
  assignmentUuid: string | null;
  fromDispatch: boolean;
  body: string;
}

export function driversGeneralMessage(driverUuid: string, afterMessageId: number, type: number): DriversGeneralMessage | null {
  const id = queryDriversDb(
    `SELECT TOP 1 MessageID FROM app.Messages WHERE DriverUserUUID = '${driverUuid}' AND MessageID > ${afterMessageId} AND MessageType = ${type} ORDER BY MessageID DESC`,
  );
  if (!id) return null;
  const row = queryDriversDb(
    `SELECT CONCAT(ISNULL(CONVERT(varchar(36), OrderAssignmentUUID), '~'), '|', CAST(IsFromDispatch AS int)) FROM app.Messages WHERE MessageID = ${id}`,
  )!;
  const [assignment, fromDispatch] = row.split('|');
  return {
    id: Number(id),
    type,
    assignmentUuid: assignment === '~' ? null : assignment,
    fromDispatch: fromDispatch === '1',
    body: queryDriversDb(`SELECT REPLACE(REPLACE(MessageBody, CHAR(13), ''), CHAR(10), ' / ') FROM app.Messages WHERE MessageID = ${id}`) ?? '',
  };
}

export class AvailabilityComms extends BasePage {
  protected readonly path = '/#/dispatch/comms';
  readonly askButton: Locator;
  readonly sentNotice: Locator;

  constructor(page: Page) {
    super(page);
    this.askButton = page.getByTestId('ask-availability');
    this.sentNotice = page.locator('.success-snackbar').filter({ hasText: ASK_SENT });
  }

  async open(driverId: string): Promise<void> {
    await this.page.goto(`${this.path}?driverId=${encodeURIComponent(driverId)}`);
    await expect(this.askButton).toBeVisible({ timeout: 30_000 });
  }

  periodItem(period: AvailabilityPeriod): Locator {
    return this.page.getByTestId(`ask-availability-${period}`);
  }

  async ask(period: AvailabilityPeriod): Promise<void> {
    await expect(this.askButton).toBeEnabled();
    await this.askButton.click();
    await this.periodItem(period).click();
  }

  async expectPeriodsOffered(): Promise<void> {
    await this.askButton.click();
    await expect(this.page.locator('[data-testid^="ask-availability-"]')).toHaveText(['Today', 'Tomorrow', 'Next week']);
    await this.page.keyboard.press('Escape');
    await expect(this.page.locator('[data-testid^="ask-availability-"]')).toHaveCount(0);
  }

  tag(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId}`).getByTestId('msg-tag-availability');
  }

  async expectTagged(messageId: number, period: AvailabilityPeriod): Promise<void> {
    await expect(this.tag(messageId)).toHaveText(AVAILABILITY_TAG[period], { timeout: 30_000 });
  }
}

export class AvailabilityReplyPage extends ReplyPage {
  readonly question: Locator;
  readonly commentTextArea: Locator;

  constructor(page: Page) {
    super(page);
    this.question = page.getByTestId('reply-text');
    this.commentTextArea = this.commentForm.locator('#reply-comment-text');
  }

  async expectQuestion(period: AvailabilityPeriod): Promise<void> {
    await expect(this.title).toHaveText(AVAILABILITY_TITLE);
    await expect(this.question).toContainText(AVAILABILITY_QUESTION[period]);
  }
}

export class AssignAvailabilityPage extends AssignDialogDispatchPage {
  readonly assignmentDate: Locator;

  constructor(page: Page) {
    super(page);
    this.assignmentDate = this.dialog.getByRole('textbox', { name: 'Assignment Date' });
  }

  async openForVendor(vendor: string): Promise<void> {
    const options = this.page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/dispatch\/assign-options$/.test(new URL(r.url()).pathname));
    await this.page.goto(this.path);
    await this.page.reload();
    expect((await options).status(), 'GET assign-options').toBe(200);
    await this.assignTruck.click();
    await expect(this.dialog).toBeVisible();
    await this.chooseVendor(vendor);
  }

  async setDate(day: Date): Promise<void> {
    const options = this.page.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/dispatch\/assign-options$/.test(new URL(r.url()).pathname) && r.url().includes(`date=${isoDay(day)}`),
    );
    await this.assignmentDate.fill(usDay(day));
    await this.assignmentDate.press('Tab');
    expect((await options).status(), 'GET assign-options?date=').toBe(200);
  }

  truckOption(truckId: number): Locator {
    return this.page.getByTestId(`assign-truck-option-${truckId}`);
  }

  async openTruckList(): Promise<void> {
    await this.truck.click();
    await expect(this.page.getByRole('listbox')).toBeVisible();
  }

  async closeTruckList(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(this.page.getByRole('listbox')).toHaveCount(0);
  }
}

export function driversMessagingEndpoint(): { host: string; port: number } | null {
  const endpoint = querySingleValue(
    `SELECT TOP 1 LTRIM(RTRIM(PropertyValue)) FROM app.EnvironmentSetting WHERE GroupName = 'Messaging' AND PropertyName = 'DriversEndpoint'`,
  );
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return { host: url.hostname, port: Number(url.port) };
  } catch {
    return null;
  }
}

export function canReach(endpoint: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: endpoint.host, port: endpoint.port, timeout: 2000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}
