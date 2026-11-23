import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { queryDriversDb, querySingleValue } from '@utils/localDb';

export const TERMS_URL = 'https://www.quarryconnect.com/terms';
export const PRIVACY_URL = 'https://www.quarryconnect.com/privacy';

export interface DriverTermsBody {
  version: string;
  termsUpdatedOn: string;
  accepted: boolean;
  acceptedVersion: string | null;
  termsUrl: string;
  privacyUrl: string;
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export interface TermsDoc {
  docId: number;
  version: string;
  updatedOn: string;
}

export interface SignedTerms {
  docId: number;
  version: string;
  createdDate: string;
  textIsNull: boolean;
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

/** The live auth.UserEULADocs row of DRIVERS (QC-988); updatedOn is ActiveDate as stored, MM/dd/yyyy. */
export function liveTermsDoc(): TermsDoc {
  return termsDoc('WHERE IsLive = 1');
}

export function termsDocByVersion(version: string): TermsDoc {
  return termsDoc(`WHERE Version = N'${sqlText(version)}'`);
}

function termsDoc(where: string): TermsDoc {
  const row = queryDriversDb(`SELECT TOP 1 CONCAT(UserEULADocId, '|', Version, '|', CONVERT(varchar(10), ActiveDate, 101)) FROM auth.UserEULADocs ${where} ORDER BY ActiveDate DESC`);
  if (!row) throw new Error(`DRIVERS has no auth.UserEULADocs row ${where}.`);
  const [docId, version, updatedOn] = row.split('|');
  return { docId: Number(docId), version, updatedOn };
}

export function liveDocCount(): number {
  return Number(queryDriversDb('SELECT COUNT(*) FROM auth.UserEULADocs WHERE IsLive = 1') ?? '0');
}

export function signedTerms(userId: string): SignedTerms[] {
  const rows = queryDriversDb(
    `SELECT STRING_AGG(CONCAT(UserEULADocId, '|', EULAVersion, '|', CONVERT(varchar(23), CreatedDate, 126), '|', IIF(UserEULADocText IS NULL, 1, 0)), ';') WITHIN GROUP (ORDER BY UserSignedEULAId)
     FROM auth.UserSignedEULAs WHERE UserId = N'${sqlText(userId.toLowerCase())}'`,
  );
  if (!rows) return [];
  return rows.split(';').map((row) => {
    const [docId, version, createdDate, textIsNull] = row.split('|');
    return { docId: Number(docId), version, createdDate, textIsNull: textIsNull === '1' };
  });
}

/** The Host's own auth.UserSignedEULAs rows of one host user (QC-986 stores the version DRIVERS reports in LinkEstablished). */
export function hostSignedTerms(hostUserId: string): { version: string; createdDate: string; textIsNull: boolean }[] {
  const rows = querySingleValue(
    `SELECT STRING_AGG(CONCAT(EULAVersion, '|', CONVERT(varchar(23), CreatedDate, 126), '|', IIF(UserEULADocText IS NULL, 1, 0)), ';') WITHIN GROUP (ORDER BY UserSignedEULAId)
     FROM auth.UserSignedEULAs WHERE UserId = N'${sqlText(hostUserId)}'`,
  );
  if (!rows) return [];
  return rows.split(';').map((row) => {
    const [version, createdDate, textIsNull] = row.split('|');
    return { version, createdDate, textIsNull: textIsNull === '1' };
  });
}

export function seedSignedTerms(userId: string, doc: TermsDoc, text: string | null): void {
  queryDriversDb(
    `SET NOCOUNT ON; INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate, UserEULADocText)
     VALUES (N'${sqlText(userId.toLowerCase())}', ${doc.docId}, N'${sqlText(doc.version)}', SYSUTCDATETIME(), ${text === null ? 'NULL' : `N'${sqlText(text)}'`}); SELECT 1`,
  );
}

export function removeSignedTerms(userId: string): void {
  queryDriversDb(`SET NOCOUNT ON; DELETE auth.UserSignedEULAs WHERE UserId = N'${sqlText(userId.toLowerCase())}'; SELECT 1`);
}

export function objectExists(name: string): boolean {
  return queryDriversDb(`SELECT CASE WHEN OBJECT_ID(N'${sqlText(name)}', N'U') IS NULL THEN 0 ELSE 1 END`) === '1';
}

export function columnsOf(table: string): string[] {
  const rows = queryDriversDb(
    `SELECT STRING_AGG(c.name, ',') WITHIN GROUP (ORDER BY c.column_id) FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'${sqlText(table)}')`,
  );
  return rows ? rows.split(',') : [];
}

/** The drivers API's Terms of Use and Privacy Policy endpoints (QC-988): GET /terms and POST /terms/accept. */
export class DriverTermsApi {
  constructor(private readonly request: APIRequestContext) {}

  async terms(accessToken: string | null): Promise<ApiResult<{ data?: DriverTermsBody }>> {
    return read(await this.request.get(`${url()}/terms`, { headers: accessToken ? bearer(accessToken) : {}, ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  async accept(accessToken: string, body: Record<string, unknown>): Promise<ApiResult<{ data?: DriverTermsBody; validationErrors?: Record<string, string[]> }>> {
    return read(await this.request.post(`${url()}/terms/accept`, { headers: bearer(accessToken), data: body, ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  async oldEula(accessToken: string | null): Promise<number> {
    const response = await this.request.get(`${url()}/eula`, { headers: accessToken ? bearer(accessToken) : {}, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    return response.status();
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

function url(): string {
  if (!env.driversApiUrl) throw new Error('DRIVERS_API_URL is not set.');
  return env.driversApiUrl;
}
