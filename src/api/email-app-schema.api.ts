import * as fs from 'fs';
import * as path from 'path';
import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';
import { queryIdentityDb, querySingleValue, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { newAuthenticatorKey } from '@utils/totp';
import { MAIL_DIR, readEmail, type ApiAnswer, type Email } from '@pages/host-password-link.page';

export const MOVED_EMAIL_TABLES = ['DeliveryMethodTypes', 'DeliveryMethods', 'MessageTypes', 'EmailTemplates'] as const;
export type MovedEmailTable = (typeof MOVED_EMAIL_TABLES)[number];

const TABLE_KEYS: Record<MovedEmailTable, string> = {
  DeliveryMethodTypes: 'DeliveryMethodTypeId',
  DeliveryMethods: 'DeliveryMethodId',
  MessageTypes: 'MessageTypeId',
  EmailTemplates: 'EmailTemplateId',
};

const TABLE_NAMES: Partial<Record<MovedEmailTable, string>> = {
  MessageTypes: 'MessageTypeName',
  EmailTemplates: 'Name',
};

export const QC798_AUDIT_TYPE = 'EmailUserCreatedAudit';
export const RESET_TYPE = 'EmailResetPassword';
export const CREATE_TYPE = 'EmailCreateUser';
export const QC896_ADMIN_EMAIL = 'e2e.qc804.qc896admin@quarryconnect.test';

export function qc896Email(name: string): string {
  return `e2e.qc896.${name}@example.com`;
}

function sqlEmail(email: string): string {
  if (!/^e2e\.qc896\.[a-z0-9-]+@example\.com$/.test(email)) throw new Error(`${email} is not a QC-896 throwaway address.`);
  return email;
}

/** Where each moved table and auth.SystemNotifications live in the host database, as "schema.table" names. */
export function emailTableLocations(): string[] {
  const names = [...MOVED_EMAIL_TABLES, 'SystemNotifications'].map((name) => `N'${name}'`).join(', ');
  const rows = querySingleValue(
    `SELECT STRING_AGG(CONCAT(SCHEMA_NAME(schema_id), '.', name), ',') WITHIN GROUP (ORDER BY name, SCHEMA_NAME(schema_id)) FROM sys.tables WHERE name IN (${names})`,
  );
  return rows ? rows.split(',') : [];
}

export function rowCount(table: MovedEmailTable): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM app.${table}`));
}

/** Foreign keys that touch a moved table, as "app.Child->app.Parent". */
export function emailTableForeignKeys(): string[] {
  const names = MOVED_EMAIL_TABLES.map((name) => `N'${name}'`).join(', ');
  const rows = querySingleValue(
    `SELECT STRING_AGG(CONCAT(OBJECT_SCHEMA_NAME(parent_object_id), '.', OBJECT_NAME(parent_object_id), '->', OBJECT_SCHEMA_NAME(referenced_object_id), '.', OBJECT_NAME(referenced_object_id)), ',')
       WITHIN GROUP (ORDER BY OBJECT_NAME(parent_object_id))
     FROM sys.foreign_keys WHERE OBJECT_NAME(parent_object_id) IN (${names}) OR OBJECT_NAME(referenced_object_id) IN (${names})`,
  );
  return rows ? rows.split(',') : [];
}

/**
 * The unmigrated database the run's copy was made from: LOCAL_SQL_DATABASE without its `_QC<n>` suffix, when that
 * database is on the same server and still holds the four tables in [auth]. Null otherwise.
 */
export function sourceDatabase(): string | null {
  const copy = env.localSql?.database ?? '';
  const source = copy.replace(/_QC\d+$/i, '');
  if (source === copy || !/^[A-Za-z0-9_]+$/.test(source)) return null;
  if (querySingleValue(`SELECT DB_ID(N'${source}')`) === null) return null;
  const tables = Number(
    querySingleValue(
      `SELECT COUNT(*) FROM [${source}].sys.tables t JOIN [${source}].sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name = N'auth' AND t.name IN (${MOVED_EMAIL_TABLES.map((name) => `N'${name}'`).join(', ')})`,
    ),
  );
  return tables === MOVED_EMAIL_TABLES.length ? source : null;
}

export interface SourceComparison {
  sourceRows: number;
  copyRows: number;
  missingFromCopy: number;
  extraNames: string[];
}

/** Compares [source].auth.<table> with the run database's app.<table> by key; `extraNames` names the copy's rows the source does not have. */
export function compareWithSource(source: string, table: MovedEmailTable): SourceComparison {
  const key = TABLE_KEYS[table];
  const nameColumn = TABLE_NAMES[table] ?? `CAST(${key} AS nvarchar(20))`;
  const sourceRows = Number(querySingleValue(`SELECT COUNT(*) FROM [${source}].auth.${table}`));
  const missingFromCopy = Number(
    querySingleValue(`SELECT COUNT(*) FROM [${source}].auth.${table} s WHERE NOT EXISTS (SELECT 1 FROM app.${table} c WHERE c.${key} = s.${key})`),
  );
  const extras = querySingleValue(
    `SELECT STRING_AGG(${nameColumn}, ',') FROM app.${table} c WHERE NOT EXISTS (SELECT 1 FROM [${source}].auth.${table} s WHERE s.${key} = c.${key})`,
  );
  return { sourceRows, copyRows: rowCount(table), missingFromCopy, extraNames: extras ? extras.split(',') : [] };
}

export function messageTypeId(name: string): number {
  return Number(querySingleValue(`SELECT MessageTypeId FROM app.MessageTypes WHERE MessageTypeName = N'${name}'`));
}

export function hostOrganisationName(): string {
  const name = querySingleValue(
    `SELECT o.OrganisationName FROM auth.Organisations o JOIN app.EnvironmentSetting s ON s.PropertyName = N'HostOrganisationId' AND TRY_CONVERT(int, s.PropertyValue) = o.OrganisationId`,
  );
  if (!name) throw new Error('The HostOrganisationId setting does not name an organisation in the host database.');
  return name;
}

export function sinkIsConfigured(): boolean {
  return (
    querySingleValue(
      `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings'
       AND ((PropertyName = N'MailServer' AND PropertyValue = N'127.0.0.1') OR (PropertyName = N'MailPort' AND PropertyValue = N'2525'))`,
    ) === '2'
  );
}

export function auditRecipientsAreSet(): boolean {
  return (
    querySingleValue(
      `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings' AND PropertyName = N'RecipientEmails' AND LEN(PropertyValue) > 0`,
    ) !== '0'
  );
}

export function lastNotificationId(): number {
  return Number(querySingleValue('SELECT ISNULL(MAX(SystemNotificationId), 0) FROM auth.SystemNotifications'));
}

export interface NotificationRow {
  messageTypeId: number;
  inError: number;
  errorMessage: string;
}

/** The newest auth.SystemNotifications row of a type after `sinceId`, sent to `email` or (for the audit email) naming it in its body. */
export function notificationFor(email: string, messageTypeName: string, sinceId: number): NotificationRow | null {
  const address = sqlEmail(email);
  const row = querySingleValue(
    `SELECT TOP 1 CONCAT(MessageTypeId, '|', CAST(ISNULL(InError, 0) AS int), '|', ISNULL(ErrorMessage, ''))
     FROM auth.SystemNotifications
     WHERE SystemNotificationId > ${sinceId} AND MessageTypeName = N'${messageTypeName}'
       AND (NotifcationTo = N'${address}' OR MessageBody LIKE N'%${address}%')
     ORDER BY SystemNotificationId DESC`,
  );
  if (!row) return null;
  const [typeId, inError, ...message] = row.split('|');
  return { messageTypeId: Number(typeId), inError: Number(inError), errorMessage: message.join('|') };
}

export function hostUserCount(): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC896.%@EXAMPLE.COM'`));
}

export function identityUserCount(): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC896.%@EXAMPLE.COM'`));
}

export function removeQc896HostUsers(): string {
  return runSeedScript('host-qc896.remove.sql');
}

/** The QC-804 throwaway host admin (two-step on) under a QC-896 name, seeded in Identity and in the run's host database. */
export function seedQc896Admin(): ThrowawayUser {
  if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway admin copies that password.');
  const authenticatorKey = newAuthenticatorKey();
  runIdentitySeedScript('identity-qc804-user.apply.sql', {
    Email: QC896_ADMIN_EMAIL,
    SourceEmail: env.admin.email,
    LastName: 'QC-896 Host admin',
    TwoFactor: '1',
    AuthenticatorKey: authenticatorKey,
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${QC896_ADMIN_EMAIL}')`);
  if (!userId) throw new Error(`The throwaway user ${QC896_ADMIN_EMAIL} was not created.`);
  runSeedScript('host-qc804-admin.apply.sql', { UserId: userId, Email: QC896_ADMIN_EMAIL });
  return { email: QC896_ADMIN_EMAIL, password: env.admin.password, userId, authenticatorKey };
}

export function removeQc896Admin(): void {
  runSeedScript('host-qc804.remove.sql');
  runIdentitySeedScript('identity-qc804.remove.sql', { EmailLike: QC896_ADMIN_EMAIL });
}

function decodeHeaderWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_match, _charset: string, encoding: string, text: string) =>
    encoding.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(
          text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16))),
          'latin1',
        ).toString('utf8'),
  );
}

export function subjectOf(mail: Email): string {
  return decodeHeaderWords(mail.headers.get('subject') ?? '').replace(/\?=\s+=\?/g, '');
}

/** Emails the sink received after `since` that name `email` in their body but were sent to someone else (the audit copy). */
export function auditMailsAbout(email: string, since: Set<string>): Email[] {
  if (!fs.existsSync(MAIL_DIR)) return [];
  return fs
    .readdirSync(MAIL_DIR)
    .filter((name) => name.endsWith('.eml') && !since.has(name))
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b))
    .map((name) => readEmail(path.join(MAIL_DIR, name)))
    .filter((mail) => !(mail.headers.get('to') ?? '').toLowerCase().includes(email) && mail.text.toLowerCase().includes(email));
}

/** POST api/manageusers/user-create on APP_API_URL with a host access token from identityexchange. */
export class Qc896UserAdminApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  async create(user: { userName: string; firstName: string; lastName: string; password: string; isActive: boolean }): Promise<ApiAnswer> {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
    const response = await this.request.post(`${env.appApiUrl}/api/manageusers/user-create`, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      data: {
        userName: user.userName,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: '',
        password: user.password,
        confirmPassword: user.password,
        role: 'Sales',
        isActive: user.isActive,
        organisationId: 0,
        organisationLocationId: 0,
        canSetOrganisation: false,
        isBillingContact: false,
      },
    });
    const text = await response.text();
    let body: ApiAnswer['body'] = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status(), body, text, retryAfter: response.headers()['retry-after'] ?? null };
  }
}
