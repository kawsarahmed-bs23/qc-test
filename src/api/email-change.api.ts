import * as crypto from 'crypto';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { env } from '@config/env.config';
import { queryIdentityDb, queryMasterDb, querySingleValue, runIdentitySeedScript, runMasterSeedScript, runSeedScript } from '@utils/localDb';
import { identityLogSince, type LogMark } from '@utils/identityLog';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';

export const EMAIL_LOCKED_MESSAGE = 'Contact support to change your email.';
export const EMAIL_EDITABLE_HINT = 'The invite is sent here. It becomes their sign-in.';
export const HOST_ORGANISATION_ID = 30;
export const VENDOR_ORGANISATION_ID = 34;
export const VENDOR_TRUCK_ORGANISATION_ID = 38;

export type HostRole = 'Admin' | 'Vendor' | 'Driver';
export type HostUserEditArea = 'manageusers' | 'vendor';

export function qc905Email(name: string): string {
  return `e2e.qc905.${name}@quarryconnect.test`;
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

function requireQc905(email: string): string {
  if (!/^e2e\.qc905\.[a-z0-9.-]+@quarryconnect\.test$/.test(email)) {
    throw new Error(`${email} is not a QC-905 throwaway address.`);
  }
  return sqlText(email);
}

/** Seeds an e2e.qc905.* Identity user with the password of ADMIN_EMAIL, two-step on unless `twoFactor` is false. */
export function seedQc905IdentityUser(name: string, twoFactor = true): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const email = qc905Email(name);
  const authenticatorKey = twoFactor ? newAuthenticatorKey() : null;
  runIdentitySeedScript('identity-qc905-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: `QC-905 ${name}`,
    TwoFactor: twoFactor ? '1' : '0',
    AuthenticatorKey: authenticatorKey ?? 'none',
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireQc905(email)}')`);
  if (!userId) {
    throw new Error(`The throwaway Identity user ${email} was not created.`);
  }
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export interface Qc905HostUser {
  email: string;
  userId: string;
  userUuid: string | null;
}

/**
 * Seeds an e2e.qc905.* host user. `accepted` links it to an Identity UserUUID (the invite was accepted, so its email is
 * locked); `identity` makes it the host user of that Identity user (same id), so the user can sign in.
 */
export function seedQc905HostUser(options: {
  name: string;
  role: HostRole;
  organisationId: number;
  accepted: boolean;
  identity?: ThrowawayUser;
}): Qc905HostUser {
  const email = options.identity?.email ?? qc905Email(options.name);
  const userId = options.identity?.userId ?? crypto.randomUUID();
  const userUuid = options.accepted ? (options.identity?.userId ?? crypto.randomUUID()) : null;
  runSeedScript('host-qc905-user.apply.sql', {
    UserId: userId,
    Email: email,
    Role: options.role,
    OrganisationId: String(options.organisationId),
    UserUuid: userUuid ?? 'none',
  });
  return { email, userId, userUuid };
}

export function removeQc905Users(): void {
  runSeedScript('host-qc905.remove.sql');
  runIdentitySeedScript('identity-qc905.remove.sql');
  runMasterSeedScript('master-qc905.remove.sql');
}

export function remainingQc905Rows(): { host: number; identity: number; requests: number; changeLogs: number } {
  return {
    host: Number(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC905.%' OR NormalizedUserName LIKE N'E2E.QC905.%'`)),
    identity: Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC905.%'`)),
    requests: Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.EmailChangeRequests WHERE NewEmail LIKE N'e2e.qc905.%' OR OldEmail LIKE N'e2e.qc905.%'`)),
    changeLogs: Number(queryMasterDb(`SELECT COUNT(*) FROM app.ChangeLogs WHERE Area = N'Users' AND Summary LIKE N'%e2e.qc905.%'`)),
  };
}

export interface LoginEmail {
  email: string;
  userName: string;
}

export function hostLoginEmail(userId: string): LoginEmail {
  const row = querySingleValue(
    `SELECT CONCAT(Email, '|', UserName, '|', NormalizedEmail, '|', NormalizedUserName) FROM auth.Users WHERE Id = N'${sqlText(userId)}'`,
  );
  if (!row) throw new Error(`The host user ${userId} is missing.`);
  const [email, userName, normalizedEmail, normalizedUserName] = row.split('|');
  if (normalizedEmail !== email.toUpperCase() || normalizedUserName !== userName.toUpperCase()) {
    throw new Error(`The host user ${userId} has normalised names that do not match: ${row}`);
  }
  return { email, userName };
}

export function identityLoginEmail(userId: string): LoginEmail & { securityStamp: string } {
  const row = queryIdentityDb(`SELECT CONCAT(Email, '|', UserName, '|', SecurityStamp) FROM auth.Users WHERE Id = N'${sqlText(userId)}'`);
  if (!row) throw new Error(`The Identity user ${userId} is missing.`);
  const [email, userName, securityStamp] = row.split('|');
  return { email, userName, securityStamp };
}

export interface EmailChangeRow {
  userUuid: string;
  oldEmail: string;
  newEmail: string;
  requestedBy: string;
  supportReference: string;
  confirmed: boolean;
  canceled: boolean;
  lifetimeHours: number;
}

export function emailChangeRows(userId: string): EmailChangeRow[] {
  const rows = queryIdentityDb(
    `SELECT STRING_AGG(CONCAT(LOWER(CONVERT(nvarchar(36), UserUUID)), '|', OldEmail, '|', NewEmail, '|', RequestedBy, '|', SupportReference, '|',` +
      ` CASE WHEN ConfirmedAt IS NULL THEN 0 ELSE 1 END, '|', CASE WHEN CanceledAt IS NULL THEN 0 ELSE 1 END, '|', DATEDIFF(minute, Created, Expires)), '~')` +
      ` WITHIN GROUP (ORDER BY EmailChangeRequestID) FROM auth.EmailChangeRequests WHERE UserId = N'${sqlText(userId)}'`,
  );
  if (!rows) return [];
  return rows.split('~').map((row) => {
    const [userUuid, oldEmail, newEmail, requestedBy, supportReference, confirmed, canceled, minutes] = row.split('|');
    return {
      userUuid,
      oldEmail,
      newEmail,
      requestedBy,
      supportReference,
      confirmed: confirmed === '1',
      canceled: canceled === '1',
      lifetimeHours: Number(minutes) / 60,
    };
  });
}

export function storedGrantCount(userId: string): number {
  return Number(
    queryIdentityDb(
      `SELECT COUNT(*) FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.Id = N'${sqlText(userId)}'`,
    ),
  );
}

export function changeLogSummaries(summaryLike: string): string[] {
  const rows = queryMasterDb(
    `SELECT STRING_AGG(Summary, '~') WITHIN GROUP (ORDER BY ChangeLogID) FROM app.ChangeLogs WHERE Area = N'Users' AND Summary LIKE N'${sqlText(summaryLike)}'`,
  );
  return rows ? rows.split('~') : [];
}

/** The confirmation link Identity logged (no mail server in Development) for an email change to `newEmail` since `mark`. */
export function emailChangeLinkSince(mark: LogMark, newEmail: string): string | null {
  const lines = identityLogSince(mark)
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().includes(newEmail.toLowerCase()) && line.includes('was not sent'));
  const pattern = new RegExp(`${env.identityUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Account/ConfirmEmailChange\\?t=[A-Za-z0-9_-]+`);
  return lines.at(-1)?.match(pattern)?.[0] ?? null;
}

export interface HostApiAnswer<T = Record<string, unknown>> {
  status: number;
  body: T | null;
  text: string;
}

/** The host API's Manage Users and Vendor > Users edit endpoints, called with the bearer token of a signed-in app page. */
export class HostUserEditApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async useTokenOf(page: Page): Promise<void> {
    const token = await page.evaluate(() => localStorage.getItem('accessToken'));
    if (!token) {
      throw new Error('The app page has no access token; sign in first.');
    }
    this.accessToken = token;
  }

  async edit(area: HostUserEditArea, userId: string): Promise<Record<string, unknown>> {
    const answer = await read(await this.request.get(`${apiUrl()}/api/${area}/user-edit/${encodeURIComponent(userId)}`, { headers: this.headers() }));
    if (answer.status !== 200 || !answer.body) {
      throw new Error(`GET ${area}/user-edit/${userId} answered ${answer.status}: ${answer.text}`);
    }
    return (answer.body['data'] ?? answer.body) as Record<string, unknown>;
  }

  async save(area: HostUserEditArea, model: Record<string, unknown>): Promise<HostApiAnswer> {
    return read(await this.request.post(`${apiUrl()}/api/${area}/user-edit`, { headers: this.headers(), data: model }));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

/** The first message the host API returned for a field, from either `validationErrors` or `errors`, matching the key case-insensitively. */
export function hostFieldError(body: Record<string, unknown> | null, field: string): string | null {
  for (const key of ['validationErrors', 'errors']) {
    const errors = body?.[key];
    if (!errors || typeof errors !== 'object') continue;
    const entry = Object.entries(errors as Record<string, unknown>).find(([name]) => name.toLowerCase() === field.toLowerCase());
    if (!entry) continue;
    const value = entry[1];
    return Array.isArray(value) ? String(value[0]) : String(value);
  }
  return null;
}

async function read(response: APIResponse): Promise<HostApiAnswer> {
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status(), body, text };
}

function apiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
