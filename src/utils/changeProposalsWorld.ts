import type { APIRequestContext } from '@playwright/test';
import { expect } from '@playwright/test';
import { env } from '@config/env.config';
import { ChangeProposalsApi, type ChangeAnswerValue } from '@api/change-proposals.api';
import { decodeJwt, PasswordGrantApi } from '@api/password-grant.api';
import { HostDriversMode, type DriversMode } from '@api/sms-routing.api';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseIdentityDb,
  queryDriversDb,
  queryIdentityDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';

export const KIND = { userDetails: 10, hostTruckNumber: 20, driverTruckNumber: 30 } as const;
export const DIRECTION = { sent: 10, received: 20 } as const;
export const STATUS = { pending: 10, approved: 20, declined: 30, superseded: 40 } as const;

export const DRIVER_EMAIL = 'e2e.qc933.driver@quarryconnect.test';
export const DRIVER2_EMAIL = 'e2e.qc933.driver2@quarryconnect.test';
export const ADMIN_EMAIL = 'e2e.qc933.admin@quarryconnect.test';
export const VENDOR_EMAIL = 'e2e.qc933.vendor@quarryconnect.test';
export const PLAIN_EMAIL = 'e2e.qc933.plain@quarryconnect.test';

export const BASE = {
  firstName: 'E2E',
  driverLastName: 'QC-933 Driver',
  driver2LastName: 'QC-933 Driver2',
  driverHostPhone: '5125559331',
  driverE164: '+15125559331',
  driver2HostPhone: '5125559332',
  driver2E164: '+15125559332',
  driverTruckNumber: 'E2E933-D',
  truckA: 'E2E933-A',
  truckB: 'E2E933-B',
};

export const QUEUE = { timeout: 45_000, intervals: [500, 1_000, 2_000] };
export const ORG_CACHE = { timeout: 150_000, intervals: [5_000] };
const DEAD_ENDPOINT = 'tcp://localhost:6299';

export interface DriverAccount {
  email: string;
  sub: string;
  token: string;
  hostUserId: string;
}

export interface World {
  originalDriversMode: DriversMode;
  hostUuid: string;
  secondHostUuid: string;
  driver: DriverAccount;
  driver2: DriverAccount;
  adminId: string;
  vendorId: string;
  plainId: string;
  vendorOrgId: number;
  truckA: number;
  truckB: number;
}

export interface ProposalRow {
  changeUuid: string;
  kind: number;
  direction: number;
  status: number;
  firstName: string | null;
  lastName: string | null;
  mobilePhone: string | null;
  notifyBySms: string | null;
  truckNumber: string | null;
  previousTruckNumber: string | null;
  changedAt: string;
  answeredByName: string | null;
  answerComment: string | null;
  other: string | null;
}

export function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`;
}

export function hostValue(query: string): string | null {
  return querySingleValue(query);
}

export function driversValue(query: string): string | null {
  return queryDriversDb(query);
}

export function canRunWorld(): boolean {
  return (
    canSeedLocalDb() && canUseDriversDb() && canUseIdentityDb() && !!env.admin && !!env.driver && !!env.appApiUrl && !!env.driversApiUrl && !!env.mobileClientId
  );
}

/** The Host's own UUID, from its Messaging settings, so the cases need no Admin UI to find the target host. */
export function localHostUuid(): string {
  return (hostValue(`SELECT LOWER(PropertyValue) FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND PropertyName = N'HostUuid'`) ?? '').trim();
}

export function hostUserId(email: string): string {
  return hostValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email}')`) ?? '';
}

function orgId(name: string): number {
  return Number(hostValue(`SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = ${sqlText(name)}`) ?? '0');
}

function parseRows(output: string | null): ProposalRow[] {
  if (!output) return [];
  const nullable = (cell: string) => (cell === '~' ? null : cell);
  return output
    .split(/\r?\n/)
    .filter((line) => line.includes('|'))
    .map((line) => {
      const [
        changeUuid,
        kind,
        direction,
        status,
        firstName,
        lastName,
        mobilePhone,
        notifyBySms,
        truckNumber,
        previousTruckNumber,
        changedAt,
        answeredByName,
        answerComment,
        other,
      ] = line.split('|');
      return {
        changeUuid: changeUuid.toLowerCase(),
        kind: Number(kind),
        direction: Number(direction),
        status: Number(status),
        firstName: nullable(firstName),
        lastName: nullable(lastName),
        mobilePhone: nullable(mobilePhone),
        notifyBySms: nullable(notifyBySms),
        truckNumber: nullable(truckNumber),
        previousTruckNumber: nullable(previousTruckNumber),
        changedAt,
        answeredByName: nullable(answeredByName),
        answerComment: nullable(answerComment),
        other: nullable(other),
      };
    });
}

const COLUMNS = (extra: string) => `CONCAT_WS(N'|', LOWER(CONVERT(nvarchar(36), ChangeUUID)), Kind, Direction, Status,
  ISNULL(FirstName, N'~'), ISNULL(LastName, N'~'), ISNULL(MobilePhone, N'~'), ISNULL(CONVERT(nvarchar(5), NotifyBySms), N'~'),
  ISNULL(TruckNumber, N'~'), ISNULL(PreviousTruckNumber, N'~'), CONVERT(nvarchar(30), ChangedAt, 126),
  ISNULL(AnsweredByName, N'~'), ISNULL(AnswerComment, N'~'), ${extra})`;

export function hostProposals(userId: string): ProposalRow[] {
  return parseRows(
    hostValue(
      `SELECT ${COLUMNS(`ISNULL(CONVERT(nvarchar(20), MessageID_FK), N'~')`)} FROM app.ChangeProposals WHERE UserID = N'${userId}' ORDER BY ChangeProposalID`,
    ),
  );
}

export function driversProposals(userUuid: string, hostUuid?: string): ProposalRow[] {
  return parseRows(
    driversValue(
      `SELECT ${COLUMNS('LOWER(CONVERT(nvarchar(36), HostUUID))')} FROM app.ChangeProposals WHERE DriverUserUUID = '${userUuid}'${hostUuid ? ` AND HostUUID = '${hostUuid}'` : ''} ORDER BY ChangeProposalID`,
    ),
  );
}

export function hostUser(userId: string): { firstName: string; lastName: string; phone: string; notifyBySms: string } {
  const row = hostValue(
    `SELECT CONCAT_WS(N'|', u.FirstName, ISNULL(u.LastName, N''), ISNULL(u.PhoneNumber, N''), ISNULL(CONVERT(nvarchar(5), CAST(s.NotifyBySms AS int)), N'~'))
     FROM auth.Users u LEFT JOIN app.UserSettings s ON s.UserID_FK = u.Id WHERE u.Id = N'${userId}'`,
  );
  const [firstName, lastName, phone, notifyBySms] = (row ?? '').split('|');
  return { firstName, lastName, phone, notifyBySms };
}

export function hostSettingsPhone(userId: string): string | null {
  return hostValue(`SELECT MobilePhone FROM app.UserSettings WHERE UserID_FK = N'${userId}'`);
}

export function digits(text: string | null | undefined): string {
  return (text ?? '').replace(/\D/g, '');
}

export function driversUser(sub: string): { firstName: string; lastName: string; phone: string; notifyBySms: string; truckNumber: string } {
  const row = driversValue(
    `SELECT CONCAT_WS(N'|', u.FirstName, ISNULL(u.LastName, N''), ISNULL(u.PhoneNumber, N''), ISNULL(CONVERT(nvarchar(5), CAST(s.NotifyBySms AS int)), N'~'), ISNULL(s.TruckNumber, N'~'))
     FROM auth.Users u JOIN app.DriverSettings s ON s.OrganisationID_FK = u.OrganisationIdFk WHERE u.UserUUID = '${sub}'`,
  );
  const [firstName, lastName, phone, notifyBySms, truckNumber] = (row ?? '').split('|');
  return { firstName, lastName, phone, notifyBySms, truckNumber };
}

export function truckNumberOf(truckId: number): string | null {
  return hostValue(`SELECT TruckNumber FROM app.TruckSettings WHERE OrganisationID_FK = ${truckId}`);
}

export function hostChangeMessages(userId: string): { messageId: number; actioned: boolean; body: string }[] {
  const rows = hostValue(
    `SELECT CONCAT_WS(N'|', MessageID, CAST(IsActioned AS int), MessageBody) FROM app.Messages WHERE DriverUserID_FK = N'${userId}' AND MessageType = 90 ORDER BY MessageID`,
  );
  return (rows ?? '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [messageId, actioned, ...body] = line.split('|');
      return { messageId: Number(messageId), actioned: actioned === '1', body: body.join('|') };
    });
}

export function hostOutgoing(): number {
  return Number(hostValue(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) ?? '0');
}

export function driversOutgoingTo(destination: 'live' | 'dead', messageTypeLike = '%'): number {
  const where = destination === 'dead' ? `destination LIKE N'${DEAD_ENDPOINT}%'` : `destination NOT LIKE N'${DEAD_ENDPOINT}%'`;
  return Number(driversValue(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes WHERE ${where} AND message_type LIKE N'${messageTypeLike}'`) ?? '0');
}

export function queuesDrained(): boolean {
  return (
    hostOutgoing() === 0 &&
    driversOutgoingTo('live') === 0 &&
    hostValue(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === '0' &&
    driversValue(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === '0'
  );
}

export async function waitForQueues(): Promise<void> {
  await expect.poll(queuesDrained, { message: 'the Host and Drivers Wolverine queues are empty', ...QUEUE }).toBe(true);
}

export function hostToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date());
}

function throwawaySubs(): string {
  return (
    (queryIdentityDb(`SELECT STRING_AGG(LOWER(Id), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC933.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none'
  );
}

export function removeWorld(): void {
  const subs = throwawaySubs();
  const drivers = runDriversSeedScript('drivers-qc933.remove.sql', { UserIds: subs });
  if (!/REMOVED left=0/.test(drivers)) throw new Error(`QC-933 rows are left behind in DRIVERS:\n${drivers}`);
  const host = runSeedScript('host-qc933.remove.sql');
  if (!/REMOVED left=0/.test(host)) throw new Error(`QC-933 rows are left behind in the host database:\n${host}`);
  runIdentitySeedScript('identity-qc933.remove.sql');
}

async function driverAccount(request: APIRequestContext, email: string, lastName: string): Promise<DriverAccount> {
  runIdentitySeedScript('identity-qc933-user.apply.sql', { Email: email, SourceEmail: env.driver!.email, LastName: lastName });
  const grant = await new PasswordGrantApi(request).passwordGrant(email, env.driver!.password);
  expect(grant.status, `password grant for ${email}: ${grant.body.error ?? ''} ${grant.body.error_description ?? ''}`).toBe(200);
  return { email, sub: String(decodeJwt(grant.body.access_token!).claims['sub']).toLowerCase(), token: grant.body.access_token!, hostUserId: '' };
}

export async function seedWorld(request: APIRequestContext, hostUuid: string): Promise<World> {
  removeWorld();
  const modes = new HostDriversMode(request);
  const originalDriversMode = modes.current() ?? 'Off';
  if (originalDriversMode !== 'On') await modes.set('On');
  const driver = await driverAccount(request, DRIVER_EMAIL, BASE.driverLastName);
  const driver2 = await driverAccount(request, DRIVER2_EMAIL, BASE.driver2LastName);

  runSeedScript('host-qc933.apply.sql', {
    SourceEmail: env.admin!.email,
    IdentityDb: env.identitySql!.database,
    DriverUuid: driver.sub,
    DriverUuid2: driver2.sub,
  });
  runDriversSeedScript('drivers-qc933.apply.sql', {
    UserId: driver.sub,
    Email: driver.email,
    Name: 'Driver',
    HostUuid: hostUuid,
    Phone: BASE.driverE164,
    TruckNumber: BASE.driverTruckNumber,
    SecondHost: '1',
  });
  runDriversSeedScript('drivers-qc933.apply.sql', {
    UserId: driver2.sub,
    Email: driver2.email,
    Name: 'Driver2',
    HostUuid: hostUuid,
    Phone: BASE.driver2E164,
    TruckNumber: 'NONE',
    SecondHost: '0',
  });

  driver.hostUserId = hostUserId(DRIVER_EMAIL);
  driver2.hostUserId = hostUserId(DRIVER2_EMAIL);
  expect(driver.hostUserId, 'the throwaway host driver').toMatch(/^[0-9a-f-]{36}$/);
  expect(driver2.hostUserId, 'the throwaway host driver without a Truck').toMatch(/^[0-9a-f-]{36}$/);

  return {
    originalDriversMode,
    hostUuid,
    secondHostUuid:
      driversValue(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostName = N'E2E QC-933 Second Host' AND CreatedBy = N'e2e'`) ?? '',
    driver,
    driver2,
    adminId: hostUserId(ADMIN_EMAIL),
    vendorId: hostUserId(VENDOR_EMAIL),
    plainId: hostUserId(PLAIN_EMAIL),
    vendorOrgId: orgId('E2E QC-933 Vendor'),
    truckA: orgId('E2E QC-933 Truck A'),
    truckB: orgId('E2E QC-933 Truck B'),
  };
}

export async function waitForHostToSeeOrganisations(api: ChangeProposalsApi, world: World): Promise<void> {
  await expect
    .poll(async () => [(await api.userEdit('manageusers', world.driver.hostUserId)).status, (await api.truckEditModel('organisation', world.truckA)).status], {
      message: 'the host API sees the new organisations once its organisation tree cache (Auth:OrganisationTreeCacheSeconds) expires',
      ...ORG_CACHE,
    })
    .toEqual([200, 200]);
}

export async function resetWorld(world: World): Promise<void> {
  await waitForQueues();
  const subs = `'${world.driver.sub}', '${world.driver2.sub}'`;
  const hostUsers = `N'${world.driver.hostUserId}', N'${world.driver2.hostUserId}'`;
  driversValue(
    `DELETE app.ChangeProposals WHERE DriverUserUUID IN (${subs});
     DELETE app.Messages WHERE DriverUserUUID IN (${subs});
     UPDATE u SET FirstName = N'${BASE.firstName}', LastName = CASE WHEN u.UserUUID = '${world.driver.sub}' THEN N'${BASE.driverLastName}' ELSE N'${BASE.driver2LastName}' END,
       PhoneNumber = CASE WHEN u.UserUUID = '${world.driver.sub}' THEN N'${BASE.driverE164}' ELSE N'${BASE.driver2E164}' END
       FROM auth.Users u WHERE u.UserUUID IN (${subs});
     UPDATE s SET TruckNumber = CASE WHEN u.UserUUID = '${world.driver.sub}' THEN N'${BASE.driverTruckNumber}' END, NotifyBySms = NULL
       FROM app.DriverSettings s JOIN auth.Users u ON u.OrganisationIdFk = s.OrganisationID_FK WHERE u.UserUUID IN (${subs});
     DELETE msg.wolverine_outgoing_envelopes WHERE destination LIKE N'${DEAD_ENDPOINT}%'`,
  );
  hostValue(
    `DELETE app.ChangeProposals WHERE UserID IN (${hostUsers});
     DELETE app.Messages WHERE DriverUserID_FK IN (${hostUsers});
     UPDATE auth.Users SET FirstName = N'${BASE.firstName}', LastName = N'${BASE.driverLastName}', PhoneNumber = N'${BASE.driverHostPhone}' WHERE Id = N'${world.driver.hostUserId}';
     UPDATE auth.Users SET FirstName = N'${BASE.firstName}', LastName = N'${BASE.driver2LastName}', PhoneNumber = N'${BASE.driver2HostPhone}' WHERE Id = N'${world.driver2.hostUserId}';
     UPDATE app.UserSettings SET NotifyBySms = 0, MobilePhone = u.PhoneNumber, ContactVersion = 0 FROM app.UserSettings s JOIN auth.Users u ON u.Id = s.UserID_FK WHERE s.UserID_FK IN (${hostUsers});
     UPDATE app.TruckSettings SET TruckNumber = N'${BASE.truckA}' WHERE OrganisationID_FK = ${world.truckA};
     UPDATE app.TruckSettings SET TruckNumber = N'${BASE.truckB}' WHERE OrganisationID_FK = ${world.truckB}`,
  );
}

export async function answerOnHost(api: ChangeProposalsApi, messageId: number, answer: ChangeAnswerValue, comment?: string) {
  return api.answerChange(messageId, answer, comment);
}

/** Puts the Host's Drivers:Mode back to what it was before the cases turned it On (a linked user needs it On). */
export async function restoreDriversMode(request: APIRequestContext, world: World | undefined): Promise<void> {
  if (!world || world.originalDriversMode === 'On') return;
  await new HostDriversMode(request).set(world.originalDriversMode);
}

/**
 * Replays an envelope Wolverine already handled, to see whether a message delivered twice is stored once. Without `peek` it
 * puts the kept inbox row of the message that carries `changeUuid` back to Incoming (unowned, so a node recovers and runs it
 * again) and returns the row id, or null when the inbox no longer keeps it. With `peek` it returns the row's status.
 */
export function replayHandledEnvelope(database: 'host' | 'drivers', messageTypePrefix: string, changeUuid: string, peek = false): string | null {
  const run = database === 'host' ? hostValue : driversValue;
  const row = `msg.wolverine_incoming_envelopes WHERE message_type LIKE N'${messageTypePrefix}%' AND CAST(body AS varchar(max)) LIKE '%${changeUuid.toLowerCase()}%'`;
  if (peek) return run(`SELECT TOP 1 status FROM ${row}`);
  const id = run(`SELECT TOP 1 CONVERT(nvarchar(36), id) FROM ${row} AND status = 'Handled'`);
  if (!id) return null;
  run(`UPDATE msg.wolverine_incoming_envelopes SET status = 'Incoming', owner_id = 0, attempts = 0, execution_time = SYSDATETIMEOFFSET() WHERE id = '${id}'`);
  return id;
}
