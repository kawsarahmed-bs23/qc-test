import * as fs from 'fs';
import type { APIRequestContext } from '@playwright/test';
import { APP_STATE, env } from '@config/env.config';
import {
  queryDriversDb,
  queryIdentityDb,
  queryMasterDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runMasterSeedScript,
  runSeedScript,
} from '@utils/localDb';
import { decodeInviteLink, type DecodedInviteLink, type PublicInviteKey } from '@utils/inviteLinks';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';
import { MailSink, type Email } from '@pages/host-password-link.page';

/**
 * QC-913: host user invites (D77/D83). Manage Users and the Vendor Portal create a host user with no password, then send it
 * an invite (POST .../user-edit/{id}/invite) that emails a Host-signed link to Identity's /invite page. Identity answers the
 * host's anonymous GET api/invites/return, which records the result and sends the person back to Identity's /invite/complete.
 * QC-915: Admin keeps each host's invite signing public keys in HOST_MASTER app.HostInviteSigningKeys.
 */

export const QC913_DOMAIN = 'example.com';
export const INVITE_EMAIL_TYPE = 'EmailUserInvite';
export const CREATE_USER_EMAIL_TYPE = 'EmailCreateUser';
export const AUDIT_EMAIL_TYPE = 'EmailUserCreatedAudit';
export const INVITE_SENT_MESSAGE = 'Invite sent. The link works for 24 hours.';
export const USER_CREATED_MESSAGE = 'User created. Send the invite from Sign-in when you are ready.';
export const ALREADY_LINKED_MESSAGE = 'This user already signs in to Quarry Connect.';
export const NOT_SENT_MESSAGE = 'The invite email could not be sent. Try again.';
export const INACTIVE_MESSAGE = 'Make the user active before sending an invite.';
export const INVALID_ANSWER_MESSAGE = 'This invite answer is not valid. Open the invite link from the email again.';
export const PRIVATE_KEY_REFUSED = 'Paste the public key only; this one holds the private part.';
export const INVITE_KEYS_SAVED = 'Invite signing keys saved. Identity uses them within 5 minutes.';
export const INVITE_LIFETIME_HOURS = 24;

export type InviteStatus = 'not-invited' | 'invited' | 'expired' | 'declined' | 'linked';
export type UserArea = 'manageusers' | 'vendor';

export const INVITE_ROW_STATUS = { sent: 10, accepted: 20, declined: 30, cancelled: 40 } as const;

export function qc913Email(name: string): string {
  return `e2e.qc913.${name}@${QC913_DOMAIN}`;
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

function requireQc913(email: string): string {
  if (!/^e2e\.qc913\.[a-z0-9.-]+@example\.com$/.test(email)) throw new Error(`${email} is not a QC-913 throwaway address.`);
  return sqlText(email);
}

export interface InviteStatusModel {
  status: InviteStatus;
  sentAt: string | null;
  expiresAt: string | null;
  respondedAt: string | null;
  canSend: boolean;
}

export interface HostAnswer<T> {
  status: number;
  data: T | null;
  message: string | null;
  errors: string[];
  text: string;
}

export interface NewHostUser {
  userName: string;
  firstName: string;
  lastName: string;
  isActive?: boolean;
}

function accessTokenIn(statePath: string): string {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { origins: { origin: string; localStorage: { name: string; value: string }[] }[] };
  const token = state.origins.flatMap((origin) => origin.localStorage).find((item) => item.name === 'accessToken')?.value;
  if (!token) throw new Error(`No accessToken in ${statePath}.`);
  return token;
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}

async function answer<T>(response: Awaited<ReturnType<APIRequestContext['get']>>): Promise<HostAnswer<T>> {
  const text = await response.text();
  let body: { data?: T; message?: string | null; errors?: string[] } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status(), data: body?.data ?? null, message: body?.message ?? null, errors: body?.errors ?? [], text };
}

/** The host API's user and invite endpoints, called with the access token of a signed-in host session (APP_STATE by default). */
export class HostUserInvitesApi {
  private token: string | null = null;

  constructor(private readonly request: APIRequestContext) {}

  useSession(statePath: string = APP_STATE): this {
    this.token = accessTokenIn(statePath);
    return this;
  }

  private headers(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async createUser(user: NewHostUser): Promise<HostAnswer<string>> {
    return answer(
      await this.request.post(`${hostApiUrl()}/api/manageusers/user-create`, {
        headers: this.headers(),
        data: {
          userName: user.userName,
          firstName: user.firstName,
          lastName: user.lastName,
          phoneNumber: '',
          role: 'Sales',
          isActive: user.isActive ?? true,
          organisationId: 0,
          organisationLocationId: 0,
          canSetOrganisation: false,
          isBillingContact: false,
        },
      }),
    );
  }

  async editForm(area: UserArea, userId: string): Promise<HostAnswer<Record<string, unknown> & { invite?: InviteStatusModel }>> {
    return answer(await this.request.get(`${hostApiUrl()}/api/${area}/user-edit/${encodeURIComponent(userId)}`, { headers: this.headers() }));
  }

  async saveUser(area: UserArea, model: Record<string, unknown>): Promise<HostAnswer<unknown>> {
    return answer(await this.request.post(`${hostApiUrl()}/api/${area}/user-edit`, { headers: this.headers(), data: model }));
  }

  async sendInvite(area: UserArea, userId: string): Promise<HostAnswer<InviteStatusModel>> {
    return answer(await this.request.post(`${hostApiUrl()}/api/${area}/user-edit/${encodeURIComponent(userId)}/invite`, { headers: this.headers() }));
  }

  /** The list row of a user from POST .../user-search, with its `invite`. */
  async listedInvite(area: UserArea, email: string): Promise<InviteStatusModel | null | undefined> {
    const result = await answer<{ data?: { userName: string; invite?: InviteStatusModel }[] } | { userName: string; invite?: InviteStatusModel }[]>(
      await this.request.post(`${hostApiUrl()}/api/${area}/user-search`, {
        headers: this.headers(),
        data: { searchKeywords: email, start: 0, length: 50, sortColumn: 'userName', sortDirection: 'asc' },
      }),
    );
    if (result.status !== 200) throw new Error(`user-search answered ${result.status}: ${result.text}`);
    const rows = Array.isArray(result.data) ? result.data : (result.data?.data ?? []);
    const row = rows.find((r) => r.userName?.toLowerCase() === email.toLowerCase());
    return row === undefined ? undefined : (row.invite ?? null);
  }

  /** The anonymous return address Identity sends the person to; redirects are not followed. */
  async inviteReturn(inviteResult: string | null): Promise<{ status: number; location: string | null; text: string }> {
    const query = inviteResult === null ? '' : `?invite_result=${encodeURIComponent(inviteResult)}`;
    const response = await this.request.get(`${hostApiUrl()}/api/invites/return${query}`, { maxRedirects: 0 });
    return { status: response.status(), location: response.headers()['location'] ?? null, text: await response.text() };
  }

  async removedDriverInvites(): Promise<number> {
    return (await this.request.get(`${hostApiUrl()}/api/driver-invites`, { headers: this.headers() })).status();
  }
}

export interface HostUserRow {
  id: string;
  userUuid: string | null;
  emailConfirmed: boolean;
  hasPassword: boolean;
  isActive: boolean;
  email: string;
}

export interface InviteRow {
  uuid: string;
  email: string;
  userType: string;
  status: number;
  replaces: string | null;
  acceptedUserUuid: string | null;
  responded: boolean;
  expiresInMinutes: number;
  sentBy: string | null;
}

export const Qc913Data = {
  hostUser(email: string): HostUserRow | null {
    const row = querySingleValue(
      `SELECT CONCAT(Id, '|', ISNULL(LOWER(CONVERT(nvarchar(36), UserUUID)), 'NULL'), '|', CAST(EmailConfirmed AS int), '|',` +
        ` CASE WHEN PasswordHash IS NULL THEN 0 ELSE 1 END, '|', CAST(IsActive AS int), '|', Email)` +
        ` FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireQc913(email)}')`,
    );
    if (!row) return null;
    const [id, userUuid, emailConfirmed, hasPassword, isActive, address] = row.split('|');
    return {
      id,
      userUuid: userUuid === 'NULL' ? null : userUuid,
      emailConfirmed: emailConfirmed === '1',
      hasPassword: hasPassword === '1',
      isActive: isActive === '1',
      email: address,
    };
  },

  hostUserById(userId: string): HostUserRow | null {
    const email = querySingleValue(`SELECT Email FROM auth.Users WHERE Id = N'${sqlText(userId)}'`);
    return email ? Qc913Data.hostUser(email) : null;
  },

  invites(userId: string): InviteRow[] {
    const rows = querySingleValue(
      `SELECT STRING_AGG(CONCAT(LOWER(CONVERT(nvarchar(36), UserInviteUUID)), '|', InvitedEmail, '|', UserType, '|', Status, '|',` +
        ` ISNULL(LOWER(CONVERT(nvarchar(36), ReplacesInviteUUID)), 'NULL'), '|', ISNULL(LOWER(CONVERT(nvarchar(36), AcceptedUserUUID)), 'NULL'), '|',` +
        ` CASE WHEN RespondedAt IS NULL THEN 0 ELSE 1 END, '|', DATEDIFF(minute, GETUTCDATE(), ExpiresAt), '|', ISNULL(SentByUserID_FK, 'NULL')), '~')` +
        ` WITHIN GROUP (ORDER BY UserInviteID) FROM app.UserInvites WHERE UserID_FK = N'${sqlText(userId)}' AND Active = 1`,
    );
    if (!rows) return [];
    return rows.split('~').map((line) => {
      const [uuid, email, userType, status, replaces, accepted, responded, expiresIn, sentBy] = line.split('|');
      return {
        uuid,
        email,
        userType,
        status: Number(status),
        replaces: replaces === 'NULL' ? null : replaces,
        acceptedUserUuid: accepted === 'NULL' ? null : accepted,
        responded: responded === '1',
        expiresInMinutes: Number(expiresIn),
        sentBy: sentBy === 'NULL' ? null : sentBy,
      };
    });
  },

  backdateInvite(inviteUuid: string): void {
    querySingleValue(
      `UPDATE app.UserInvites SET ExpiresAt = DATEADD(minute, -5, GETUTCDATE()) WHERE UserInviteUUID = '${inviteUuid}' AND InvitedEmail LIKE N'e2e.qc913.%@example.com'`,
    );
  },

  notificationCount(email: string, messageTypeName?: string): number {
    const type = messageTypeName ? ` AND MessageTypeName = N'${sqlText(messageTypeName)}'` : '';
    return Number(querySingleValue(`SELECT COUNT(*) FROM auth.SystemNotifications WHERE NotifcationTo LIKE N'%${requireQc913(email)}%'${type}`));
  },

  auditNotificationCount(email: string): number {
    return Number(
      querySingleValue(
        `SELECT COUNT(*) FROM auth.SystemNotifications WHERE MessageTypeName = N'${AUDIT_EMAIL_TYPE}' AND MessageBody LIKE N'%${requireQc913(email)}%'`,
      ),
    );
  },

  latestInviteNotification(email: string): { body: string; bcc: string | null; inError: number; error: string } | null {
    const row = querySingleValue(
      `SELECT TOP 1 CONCAT(CASE WHEN MessageBody IS NULL THEN 'NULL' WHEN MessageBody = N'' THEN 'EMPTY' ELSE 'TEXT' END, '|', ISNULL(NotificationBcc, 'NULL'), '|',` +
        ` CAST(ISNULL(InError, 0) AS int), '|', ISNULL(ErrorMessage, '')) FROM auth.SystemNotifications` +
        ` WHERE NotifcationTo LIKE N'%${requireQc913(email)}%' AND MessageTypeName = N'${INVITE_EMAIL_TYPE}' ORDER BY SystemNotificationId DESC`,
    );
    if (!row) return null;
    const [body, bcc, inError, ...error] = row.split('|');
    return { body, bcc: bcc === 'NULL' ? null : bcc, inError: Number(inError), error: error.join('|') };
  },

  auditRecipientsAreSet(): boolean {
    return (
      querySingleValue(
        `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings' AND PropertyName = N'RecipientEmails' AND LEN(PropertyValue) > 0`,
      ) !== '0'
    );
  },

  /** The staff audit email of user-create can be sent: RecipientEmails is set and the EmailUserCreatedAudit template is active. */
  auditEmailIsSetUp(): boolean {
    return (
      Qc913Data.auditRecipientsAreSet() &&
      querySingleValue(`SELECT COUNT(*) FROM app.EmailTemplates WHERE Name = N'${AUDIT_EMAIL_TYPE}' AND IsActive = 1`) !== '0'
    );
  },

  /** EmailSettings MailServer/MailPort point at the SMTP sink (127.0.0.1:SMTP_SINK_PORT). */
  sinkIsConfigured(): boolean {
    return (
      querySingleValue(
        `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings'
         AND ((PropertyName = N'MailServer' AND PropertyValue = N'127.0.0.1') OR (PropertyName = N'MailPort' AND PropertyValue = N'${env.smtpSinkPort}'))`,
      ) === '2'
    );
  },

  /** The host can sign invite links: Invites:SigningKey is set (its value is never read), and EmailSettings:ApiPublicUrl is APP_API_URL. */
  invitesAreSetUp(): boolean {
    const signingKey = querySingleValue(
      `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'Invites' AND PropertyName = N'SigningKey' AND LEN(PropertyValue) > 0`,
    );
    const publicUrl = querySingleValue(
      `SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings' AND PropertyName = N'ApiPublicUrl'`,
    );
    return signingKey !== '0' && (publicUrl ?? '').replace(/\/+$/, '') === env.appApiUrl;
  },

  hostUuid(): string {
    const uuid = querySingleValue(
      `SELECT TOP 1 LOWER(PropertyValue) FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND PropertyName = N'HostUuid'`,
    );
    if (!uuid) throw new Error('The host has no Messaging:HostUuid setting.');
    return uuid;
  },

  hostHasTable(table: string): boolean {
    return querySingleValue(`SELECT CASE WHEN OBJECT_ID(N'${sqlText(table)}', N'U') IS NULL THEN 0 ELSE 1 END`) === '1';
  },

  identityUserUuid(email: string): string | null {
    return queryIdentityDb(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireQc913(email)}')`);
  },

  identityUserUuids(): string[] {
    const rows = queryIdentityDb(
      `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), UserUUID)), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM'`,
    );
    return rows ? rows.split(',') : [];
  },

  activeDriverLinks(hostUuid: string, userUuid: string): number {
    return Number(queryDriversDb(`SELECT COUNT(*) FROM app.DriverHostLinks WHERE HostUUID = '${hostUuid}' AND UserUUID = '${userUuid}' AND Active = 1`));
  },

  vendorTruck(n: 1 | 2): { id: number; name: string } {
    const id = querySingleValue(
      `SELECT t.OrganisationID FROM auth.Organisations t JOIN auth.Organisations v ON v.OrganisationID = t.ParentOrganisationIdFk` +
        ` WHERE v.OrganisationName = N'E2E QC-913 Vendor' AND t.OrganisationName = N'E2E QC-913 Truck ${n}' AND t.UpdatedBy = 'e2e-qc913'`,
    );
    if (!id) throw new Error('The QC-913 vendor trucks are not seeded.');
    return { id: Number(id), name: `E2E QC-913 Truck ${n}` };
  },

  /** The size of HOST_API_LOG now, to read only what the host logs after this point; 0 when it is not set. */
  hostLogMark(): number {
    if (!env.hostApiLog || !fs.existsSync(env.hostApiLog)) return 0;
    return fs.statSync(env.hostApiLog).size;
  },

  /** What HOST_API_LOG gained since `mark`, or null when HOST_API_LOG is not set. */
  hostLogSince(mark: number): string | null {
    if (!env.hostApiLog || !fs.existsSync(env.hostApiLog)) return null;
    return fs.readFileSync(env.hostApiLog).subarray(mark).toString('utf8');
  },

  hostLogContains(text: string): boolean {
    if (!env.hostApiLog || !fs.existsSync(env.hostApiLog)) return false;
    return fs.readFileSync(env.hostApiLog, 'utf8').includes(text);
  },
};

/** Seeds an e2e.qc913.* Identity login with the password of ADMIN_EMAIL (two-step on when `twoFactor`). */
export function seedQc913Login(name: string, twoFactor: boolean): ThrowawayUser {
  if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway logins copy that password.');
  const email = qc913Email(name);
  const authenticatorKey = twoFactor ? newAuthenticatorKey() : null;
  runIdentitySeedScript('identity-qc913-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: `QC-913 ${name}`,
    TwoFactor: twoFactor ? '1' : '0',
    AuthenticatorKey: authenticatorKey ?? 'none',
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireQc913(email)}')`);
  if (!userId) throw new Error(`The throwaway login ${email} was not created.`);
  return { email, password: env.admin.password, userId, authenticatorKey };
}

/** Seeds the host Admin user (role Admin, host organisation) for the login `admin`. */
export function seedQc913HostAdmin(admin: ThrowawayUser): void {
  runSeedScript('host-qc913-admin.apply.sql', { UserId: admin.userId, Email: admin.email });
}

/** Seeds the 'E2E QC-913 Vendor' organisation with two trucks and its Vendor host user for the login `vendor`. */
export function seedQc913Vendor(vendor: ThrowawayUser): void {
  runSeedScript('host-qc913-vendor.apply.sql', { UserId: vendor.userId, Email: vendor.email, IdentityDb: env.identitySql!.database });
}

export interface Qc913Removal {
  host: string;
  identity: string;
  drivers: string | null;
}

/** Removes every QC-913 row: host users, invites and notifications, the vendor, Identity logins and their DRIVERS links. */
export function removeQc913Data(): Qc913Removal {
  const subs = env.identitySql ? Qc913Data.identityUserUuids() : [];
  const drivers = env.driversSql ? runDriversSeedScript('drivers-qc913.remove.sql', { UserIds: subs.length ? subs.join(',') : 'none' }) : null;
  const host = runSeedScript('host-qc913.remove.sql');
  const identity = runIdentitySeedScript('identity-qc913.remove.sql');
  return { host, identity, drivers };
}

export function registerTestInviteKey(clientId: string, key: PublicInviteKey): void {
  runMasterSeedScript('master-qc913-invite-key.apply.sql', { ClientId: clientId, Kid: key.kid, X: key.x, Y: key.y });
}

export function removeTestInviteKeys(): string {
  return runMasterSeedScript('master-qc913-invite-keys.remove.sql');
}

export interface MasterInviteKeyRow {
  kid: string;
  active: boolean;
  x: string;
  y: string;
}

export function masterInviteKeys(hostUuid: string): MasterInviteKeyRow[] {
  const rows = queryMasterDb(
    `SELECT STRING_AGG(CONCAT(k.Kid, '|', CAST(k.Active AS int), '|', k.X, '|', k.Y), '~') WITHIN GROUP (ORDER BY k.HostInviteSigningKeyID)` +
      ` FROM app.HostInviteSigningKeys k JOIN app.Hosts h ON h.HostID = k.HostID_FK WHERE h.HostUUID = '${hostUuid}'`,
  );
  if (!rows) return [];
  return rows.split('~').map((line) => {
    const [kid, active, x, y] = line.split('|');
    return { kid, active: active === '1', x, y };
  });
}

/** True when Identity's /invite page takes the link (setup or existing-login view), false when it shows #invite-failed. */
export async function identityAcceptsLink(request: APIRequestContext, token: string): Promise<boolean> {
  const response = await request.get(`${env.identityUrl}/invite?t=${encodeURIComponent(token)}`, { ignoreHTTPSErrors: env.ignoreHttpsErrors });
  const html = await response.text();
  return response.ok() && !html.includes('id="invite-failed"') && (html.includes('id="invite-setup"') || html.includes('id="invite-existing"'));
}

export function masterHasInviteKeys(): boolean {
  return queryMasterDb(`SELECT CASE WHEN OBJECT_ID(N'app.HostInviteSigningKeys', N'U') IS NULL THEN 0 ELSE 1 END`) === '1';
}

export function hostUuidOfClient(clientId: string): string | null {
  return queryMasterDb(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE ClientID = N'${sqlText(clientId)}'`);
}

export interface InviteEmail {
  mail: Email;
  subject: string;
  acceptUrl: string;
  declineUrl: string;
  link: DecodedInviteLink;
}

function decodeHeaderWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, encoding: string, text: string) =>
    encoding.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(
          text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) => String.fromCharCode(parseInt(hex, 16))),
          'latin1',
        ).toString('utf8'),
  );
}

export function subjectOfMail(mail: Email): string {
  return decodeHeaderWords(mail.headers.get('subject') ?? '').replace(/\?=\s+=\?/g, '');
}

/** The Accept invite and decline links of an EmailUserInvite email, and the signed link token they carry. */
export function inviteEmailParts(mail: Email): InviteEmail {
  const urls = [...mail.text.matchAll(/href="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
  const identity = env.identityUrl.replace(/\/+$/, '');
  const acceptUrl = urls.find((url) => url.startsWith(`${identity}/invite?t=`));
  const declineUrl = urls.find((url) => url.startsWith(`${identity}/invite/decline?t=`));
  if (!acceptUrl || !declineUrl) throw new Error(`${mail.file} has no Accept invite / decline links to ${identity}/invite: ${urls.join(', ')}`);
  const token = new URL(acceptUrl).searchParams.get('t') ?? '';
  return { mail, subject: subjectOfMail(mail), acceptUrl, declineUrl, link: decodeInviteLink(token) };
}

/** Waits for the invite email to `address` after `since` and reads its links. */
export async function inviteEmailTo(address: string, since: Set<string>): Promise<InviteEmail> {
  return inviteEmailParts(await MailSink.latestTo(address, since));
}

export function mailsTo(address: string, since: Set<string>): Email[] {
  return MailSink.newTo(address, since);
}
