import { randomUUID } from 'crypto';
import { env } from '@config/env.config';
import { queryDriversDb, querySingleValue, queryUnicodeText, runDriversSeedScript, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import { DIRECTION, randomCode, sha256Hex } from './reply-links.page';
import { driversLog } from './sms-routing.page';

export const CONFIRMATION_MARKER = 'E2E-QC937-RC';

export const PLAIN_EMAIL = 'e2e.qc937.plain@quarryconnect.test';
export const LINKED_EMAIL = 'e2e.qc937.linked@quarryconnect.test';
export const LINKED_PHONE = '+15125559372';
export const PLAIN_PHONE = '+15125559371';

export const DRIVERS_SMS_FROM = '+15005550937';

export const SYSTEM_MESSAGE_TYPE = 50;

export type Who = 'plain' | 'linked';

export interface SlotSpec {
  slot: string;
  who: Who;
}

export interface Slot extends SlotSpec {
  code: string;
  assignmentUuid: string;
  messageUuid: string;
  assignmentId: number;
  messageId: number;
}

export interface ConfirmationSeed {
  plainId: string;
  linkedId: string;
  jobDoc: string;
  slots: Record<string, Slot>;
}

export function confirmationText(jobDoc: string, label: 'Accept' | 'Decline'): string {
  return `${jobDoc}: you replied ${label}. Thanks.`;
}

export function pickTemplateDriver(): string {
  const id = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u
    JOIN auth.UserToRoles r ON r.UserId = u.Id AND r.RoleName = N'Driver'
    WHERE u.IsActive = 1 AND u.NormalizedEmail NOT LIKE N'E2E.%'
      AND EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL
        AND ISNULL(a.Notes, N'') NOT LIKE N'E2E%')
    ORDER BY u.Id`);
  if (!id) throw new Error('QC-937 needs an active host Driver with a truck assignment to copy.');
  return id;
}

export function driversHostUuid(): string {
  const uuid = queryDriversDb(
    `SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = N'${env.hostName.replace(/'/g, "''")}' AND Active = 1`,
  );
  if (!uuid) throw new Error(`The host '${env.hostName}' (HOST_NAME) is not an active host in the DRIVERS database.`);
  return uuid;
}

export function jobDocOfAssignment(orderAssignmentId: number): string {
  const jobId = Number(
    querySingleValue(`SELECT o.JobID_FK FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK WHERE a.OrderAssignmentID = ${orderAssignmentId}`),
  );
  return `JOB${String(jobId).padStart(4, '0')}`;
}

export function seedConfirmationRows(specs: SlotSpec[]): ConfirmationSeed {
  const plainId = randomUUID();
  const linkedId = randomUUID();
  const slots = specs.map((s) => ({ ...s, code: randomCode(), assignmentUuid: randomUUID(), messageUuid: randomUUID(), assignmentId: 0, messageId: 0 }));
  const rows = slots.map((s) => [s.slot, sha256Hex(s.code), s.assignmentUuid, s.messageUuid, s.who].join(',')).join(';');
  const output = runSeedScript('reply-confirmation-qc937.apply.sql', {
    PlainId: plainId,
    LinkedId: linkedId,
    TemplateDriverId: pickTemplateDriver(),
    Rows: rows,
  });
  for (const slot of slots) {
    const match = output.match(new RegExp(`SEED ${slot.slot} assignment=(\\d+);message=(\\d+)`));
    if (!match) throw new Error(`The QC-937 seed did not report slot ${slot.slot}:\n${output}`);
    slot.assignmentId = Number(match[1]);
    slot.messageId = Number(match[2]);
  }
  const jobDoc = jobDocOfAssignment(slots[0].assignmentId);
  return { plainId, linkedId, jobDoc, slots: Object.fromEntries(slots.map((s) => [s.slot, s])) };
}

export function seedLinkedDriversRows(seed: ConfirmationSeed, hostUuid: string, sourceEmail: string): void {
  runIdentitySeedScript('identity-qc937-user.apply.sql', { Email: LINKED_EMAIL, UserId: seed.linkedId, SourceEmail: sourceEmail });
  const rows = Object.values(seed.slots)
    .map((s) => [s.slot, sha256Hex(s.code), s.assignmentUuid, s.messageUuid, s.who].join(','))
    .join(';');
  runDriversSeedScript('drivers-qc937.apply.sql', { UserId: seed.linkedId, HostUuid: hostUuid, JobDoc: seed.jobDoc, Rows: rows });
}

export function removeConfirmationRows(linkedId: string): void {
  const host = runSeedScript('reply-confirmation-qc937.remove.sql');
  const drivers = runDriversSeedScript('drivers-qc937.remove.sql', { UserId: linkedId });
  runIdentitySeedScript('identity-qc937.remove.sql');
  if (!/REMOVED assignments=0;messages=0;users=0/.test(host)) throw new Error(`QC-937 host rows are left behind:\n${host}`);
  if (!/REMOVED left=0/.test(drivers)) throw new Error(`QC-937 DRIVERS rows are left behind:\n${drivers}`);
}

export interface ConfirmationRow {
  id: number;
  messageType: number;
  channel: number;
  direction: number;
  body: string | null;
  replyTo: number | null;
  phone: string | null;
}

export function confirmationRowsOf(offerMessageId: number): ConfirmationRow[] {
  const ids = querySingleValue(`SELECT STRING_AGG(CAST(MessageID AS varchar(12)), ',') WITHIN GROUP (ORDER BY MessageID)
    FROM app.Messages WHERE ReplyToMessageID_FK = ${offerMessageId} AND Direction = ${DIRECTION.Outbound}`);
  return (ids ? ids.split(',').map(Number) : []).map((id) => {
    const meta = querySingleValue(`SELECT CONCAT(MessageType, '|', Channel, '|', Direction, '|', ISNULL(CAST(ReplyToMessageID_FK AS varchar(12)), '~'), '|', ISNULL(PhoneNumber, '~'))
      FROM app.Messages WHERE MessageID = ${id}`)!;
    const [messageType, channel, direction, replyTo, phone] = meta.split('|');
    return {
      id,
      messageType: Number(messageType),
      channel: Number(channel),
      direction: Number(direction),
      replyTo: replyTo === '~' ? null : Number(replyTo),
      phone: phone === '~' ? null : phone,
      body: queryUnicodeText('MessageBody', `app.Messages WHERE MessageID = ${id}`),
    };
  });
}

export function outboundSystemTextsToPhone(phone: string, afterMessageId: number): number {
  return Number(
    querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE PhoneNumber = N'${phone}' AND Direction = ${DIRECTION.Outbound}
      AND MessageType = ${SYSTEM_MESSAGE_TYPE} AND MessageID > ${afterMessageId}`),
  );
}

export function hostMessageWatermark(): number {
  return Number(querySingleValue('SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages'));
}

export function hostAssignmentStatus(assignmentId: number): number {
  return Number(querySingleValue(`SELECT OrderAssignmentStatusID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = ${assignmentId}`));
}

export function driversAssignmentStatus(assignmentUuid: string): number {
  return Number(queryDriversDb(`SELECT Status FROM app.OrderAssignments WHERE OrderAssignmentUUID = '${assignmentUuid}'`));
}

export function driversAnswerCode(messageUuid: string): string | null {
  return queryDriversDb(`SELECT AnswerResponseCode FROM app.Messages WHERE MessageUUID = '${messageUuid}'`);
}

export interface DriversHostRow {
  smsFromNumber: string | null;
  replyConfirmation: number;
}

export function driversHostRow(hostUuid: string): DriversHostRow {
  const row = queryDriversDb(`SELECT CONCAT(ISNULL(SmsFromNumber, '~'), '|', CAST(ReplyConfirmation AS int)) FROM app.Hosts WHERE HostUUID = '${hostUuid}'`)!;
  const [from, flag] = row.split('|');
  return { smsFromNumber: from === '~' ? null : from, replyConfirmation: Number(flag) };
}

export function setDriversHostRow(hostUuid: string, row: DriversHostRow): void {
  const from = row.smsFromNumber === null ? 'NULL' : `N'${row.smsFromNumber}'`;
  queryDriversDb(`UPDATE app.Hosts SET SmsFromNumber = ${from}, ReplyConfirmation = ${row.replyConfirmation} WHERE HostUUID = '${hostUuid}'`);
}

export function loggedTexts(mark: number): { from: string; length: number }[] {
  const pattern = /SMS from (\S+) to \S+ logged instead of sent \((\d+) characters\)/g;
  return [...driversLog.since(mark).matchAll(pattern)].map((m) => ({ from: m[1], length: Number(m[2]) }));
}

export function loggedTextsFrom(mark: number, from: string): number[] {
  return loggedTexts(mark)
    .filter((t) => t.from === from)
    .map((t) => t.length);
}

