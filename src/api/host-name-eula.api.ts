import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import {
  queryIdentityDb,
  querySingleValue,
  queryUnicodeText,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';

export const HOST_NAME_TOKEN = '{{HostName}}';
const QC909_EMAIL_LIKE = 'e2e.qc909.%@quarryconnect.test';

export interface LiveHostEula {
  docId: number;
  version: string;
  sha256: string;
  text: string;
}

export interface HostSignedEula {
  docId: number;
  version: string;
  text: string | null;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export function qc909Email(name: string): string {
  return `e2e.qc909.${name}@quarryconnect.test`;
}

/** Seeds an Identity user (two-step on) and a host admin of the Host organisation with the same id; `accepted` adds a pre-QC-909 acceptance. */
export function seedQc909HostUser(name: string, eula: 'accepted' | 'none'): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const email = qc909Email(name);
  const authenticatorKey = newAuthenticatorKey();
  runIdentitySeedScript('identity-qc909-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: 'QC-909 Admin',
    TwoFactor: '1',
    AuthenticatorKey: authenticatorKey,
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${sqlText(email)}')`);
  if (!userId) {
    throw new Error(`The throwaway Identity user ${email} was not created.`);
  }
  runSeedScript('host-qc909-user.apply.sql', { UserId: userId, Email: email, Eula: eula });
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function removeQc909HostUsers(): void {
  runSeedScript('host-qc909.remove.sql');
  runIdentitySeedScript('identity-qc909.remove.sql', { EmailLike: QC909_EMAIL_LIKE });
}

export function remainingQc909Rows(): { hostUsers: number; acceptances: number; identityUsers: number } {
  return {
    hostUsers: Number(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC909.%@QUARRYCONNECT.TEST'`)),
    acceptances: Number(
      querySingleValue(
        `SELECT COUNT(*) FROM auth.UserSignedEULAs s JOIN auth.Users u ON u.Id = s.UserId WHERE u.NormalizedEmail LIKE N'E2E.QC909.%@QUARRYCONNECT.TEST'`,
      ),
    ),
    identityUsers: Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC909.%@QUARRYCONNECT.TEST'`)),
  };
}

export function liveHostEula(): LiveHostEula {
  const where = 'auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC';
  const row = querySingleValue(`SELECT TOP 1 CONCAT(UserEULADocId, '|', Version, '|', CONVERT(varchar(64), HASHBYTES('SHA2_256', EULAText), 2)) FROM ${where}`);
  if (!row) {
    throw new Error('The host database has no live EULA document.');
  }
  const [docId, version, sha256] = row.split('|');
  const text = queryUnicodeText('EULAText', `(SELECT TOP 1 EULAText FROM ${where}) d`);
  return { docId: Number(docId), version, sha256, text: text ?? '' };
}

export interface HostTermsVersion {
  docId: number;
  version: string;
  updatedOn: string;
}

/** The live Terms of Use and Privacy Policy version (QC-986), with ActiveDate as stored, MM/dd/yyyy. */
export function liveHostTerms(): HostTermsVersion {
  return hostTermsRow('WHERE IsLive = 1 ORDER BY ActiveDate DESC', 'The host database has no live Terms of Use and Privacy Policy version.');
}

/** The newest version that is no longer live: what a user accepted before the live version came out. */
export function previousHostTerms(): HostTermsVersion | null {
  const count = Number(querySingleValue('SELECT COUNT(*) FROM auth.UserEULADocs WHERE IsLive = 0'));
  return count > 0 ? hostTermsRow('WHERE IsLive = 0 ORDER BY ActiveDate DESC', 'No earlier version.') : null;
}

function hostTermsRow(whereOrder: string, missing: string): HostTermsVersion {
  const row = querySingleValue(
    `SELECT TOP 1 CONCAT(UserEULADocId, '|', Version, '|', CONVERT(varchar(10), ActiveDate, 101)) FROM auth.UserEULADocs ${whereOrder}`,
  );
  if (!row) {
    throw new Error(missing);
  }
  const [docId, version, updatedOn] = row.split('|');
  return { docId: Number(docId), version, updatedOn };
}

/** Moves the user's seeded acceptance to an earlier version, as a user who accepted before the live version came out. */
export function moveAcceptanceToVersion(userId: string, terms: HostTermsVersion): void {
  querySingleValue(
    `SET NOCOUNT ON; UPDATE auth.UserSignedEULAs SET UserEULADocId = ${terms.docId}, EULAVersion = N'${sqlText(terms.version)}' WHERE UserId = N'${sqlText(userId)}'; SELECT 1`,
  );
}

export function hostOrganisationName(): string {
  const name = querySingleValue(
    `SELECT o.OrganisationName FROM auth.Organisations o JOIN app.EnvironmentSetting s ON s.PropertyName = N'HostOrganisationId' AND TRY_CONVERT(int, s.PropertyValue) = o.OrganisationId`,
  );
  if (!name) {
    throw new Error('The HostOrganisationId setting does not name an organisation in the host database.');
  }
  return name;
}

export function applyHostNameToken(): void {
  runSeedScript('host-qc909-eula-token.apply.sql');
}

export function rollBackHostNameToken(): void {
  runSeedScript('host-qc909-eula-token.remove.sql');
}

export function hostSignedEulas(userId: string): HostSignedEula[] {
  const rows = querySingleValue(
    `SELECT STRING_AGG(CONCAT(UserSignedEULAId, '|', UserEULADocId, '|', EULAVersion), ';') FROM auth.UserSignedEULAs WHERE UserId = N'${sqlText(userId)}'`,
  );
  if (!rows) return [];
  return rows.split(';').map((row) => {
    const [id, docId, version] = row.split('|');
    return { docId: Number(docId), version, text: queryUnicodeText('UserEULADocText', `auth.UserSignedEULAs WHERE UserSignedEULAId = ${Number(id)}`) };
  });
}

export function htmlEncode(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The host API's EULA endpoints (QC-909), against APP_API_URL with a host access token from identityexchange. */
export class HostEulaApi {
  constructor(private readonly request: APIRequestContext) {}

  async signUserEula(
    accessToken: string,
  ): Promise<ApiResult<{ data?: { userEULADocId: number; eulaVersion: string; termsUpdatedOn: string; userEULADocText?: string } }>> {
    return read(
      await this.request.get(`${hostApiUrl()}/api/UserSignedEULAs/SignUserEULA`, { headers: bearer(accessToken), ignoreHTTPSErrors: env.ignoreHttpsErrors }),
    );
  }

  async accept(accessToken: string, body: Record<string, unknown>): Promise<ApiResult<{ statusCode?: number; data?: unknown }>> {
    return read(
      await this.request.post(`${hostApiUrl()}/api/UserSignedEULAs/Accept`, {
        headers: bearer(accessToken),
        data: body,
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  async hasSignedLatest(accessToken: string): Promise<boolean> {
    const result = await read<{ data?: { hasLastEULABeenSigned?: boolean } }>(
      await this.request.get(`${hostApiUrl()}/api/Account/CheckUserEULASign`, { headers: bearer(accessToken), ignoreHTTPSErrors: env.ignoreHttpsErrors }),
    );
    if (result.status !== 200 || typeof result.body?.data?.hasLastEULABeenSigned !== 'boolean') {
      throw new Error(`CheckUserEULASign answered ${result.status} without hasLastEULABeenSigned.`);
    }
    return result.body.data.hasLastEULABeenSigned;
  }
}

async function read<T>(response: APIResponse): Promise<ApiResult<T>> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status(), body: body as T };
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}
