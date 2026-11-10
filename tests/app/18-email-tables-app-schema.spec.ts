// QC-896: EmailTemplates, DeliveryMethodTypes, DeliveryMethods and MessageTypes moved from [auth] to [app]
// (migrations/pending/move_email_tables_to_app_schema.sql); auth.SystemNotifications stays. Local only.
// Runs against APP_API_URL / LOCAL_SQL_DATABASE (point both at the migrated host API and its database copy, e.g.
// APP_API_URL=https://localhost:7426 LOCAL_SQL_DATABASE=QuarryConnect_Dev_QC896). EMLAPP-02 compares the copy with the
// database it was copied from (LOCAL_SQL_DATABASE without its _QC<n> suffix) while that one is still unmigrated.
// Needs the SMTP sink (`node scripts/smtp-sink.mjs`, 127.0.0.1:2525) and EmailSettings MailServer/MailPort pointing at it.
// Signs in through Identity (host.local code flow + identityexchange, no host UI) as e2e.qc804.qc896admin@quarryconnect.test;
// every e2e.qc896.*@example.com user and its notifications are removed by seed/host-qc896.remove.sql.
import * as crypto from 'crypto';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb } from '@utils/localDb';
import { HostAccountApi, identityAccessToken } from '@api/host-account.api';
import {
  CREATE_TYPE,
  MOVED_EMAIL_TABLES,
  QC798_AUDIT_TYPE,
  RESET_TYPE,
  Qc896UserAdminApi,
  auditMailsAbout,
  auditRecipientsAreSet,
  compareWithSource,
  emailTableForeignKeys,
  emailTableLocations,
  hostOrganisationName,
  hostUserCount,
  identityUserCount,
  lastNotificationId,
  messageTypeId,
  notificationFor,
  qc896Email,
  removeQc896Admin,
  removeQc896HostUsers,
  rowCount,
  seedQc896Admin,
  sinkIsConfigured,
  sourceDatabase,
  subjectOf,
} from '@api/email-app-schema.api';
import { HostPasswordApi, MailSink, passwordLinkIn, type Email } from '@pages/host-password-link.page';

const AUDITED = qc896Email('audited');
const ACTIVE = qc896Email('active');

function newPassword(): string {
  return `Qc896!${crypto.randomBytes(5).toString('hex')}`;
}

function expectPasswordLink(mail: Email, email: string, typedPassword: string): void {
  const link = passwordLinkIn(mail);
  expect(link.email).toBe(email);
  expect(link.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  expect(new URL(link.raw).pathname).toBe('/authentication/reset-password');
  expect(mail.text).not.toContain(typedPassword);
  expect(mail.text).not.toMatch(/\{\{\s*Password\s*\}\}/i);
  expect(mail.text).not.toMatch(/(temporary|new)\s+password\s*(is)?\s*:/i);
  expect(mail.text, 'every template token is replaced').not.toContain('{{');
}

test.describe('Email templates and delivery tables live in the app schema (QC-896)', () => {
  test.skip(env.name !== 'local' || !canSeedLocalDb(), 'Needs the local host database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE).');

  test('EMLAPP-01 the four email tables are in app and not in auth, and auth.SystemNotifications is still in auth', () => {
    const locations = emailTableLocations();
    for (const table of MOVED_EMAIL_TABLES) {
      expect(locations, `app.${table} exists`).toContain(`app.${table}`);
      expect(locations, `auth.${table} is gone`).not.toContain(`auth.${table}`);
      expect(rowCount(table), `app.${table} has rows`).toBeGreaterThan(0);
    }
    expect(locations).toContain('auth.SystemNotifications');
    expect(locations).not.toContain('app.SystemNotifications');
    expect(messageTypeId(RESET_TYPE)).toBeGreaterThan(0);
    expect(messageTypeId(CREATE_TYPE)).toBeGreaterThan(0);
  });

  test('EMLAPP-02 every row of the unmigrated tables moved with its id, the only extras are QC-798 rows, and the foreign keys run app to app', () => {
    expect(emailTableForeignKeys()).toEqual(['app.DeliveryMethods->app.DeliveryMethodTypes', 'app.MessageTypes->app.DeliveryMethods']);

    const source = sourceDatabase();
    test.skip(source === null, 'No unmigrated source database (LOCAL_SQL_DATABASE without its _QC<n> suffix, with the tables still in auth) to compare with.');
    for (const table of MOVED_EMAIL_TABLES) {
      const compared = compareWithSource(source!, table);
      expect(compared.missingFromCopy, `every ${source}.auth.${table} row is in app.${table}`).toBe(0);
      expect(
        compared.extraNames.every((name) => name === QC798_AUDIT_TYPE),
        `extra app.${table} rows: ${compared.extraNames.join(', ')}`,
      ).toBe(true);
      expect(compared.copyRows, `app.${table} has the source's rows plus the QC-798 ones`).toBe(compared.sourceRows + compared.extraNames.length);
    }
  });
});

test.describe('Host emails read the moved tables and still send (QC-896)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb(), 'Needs the local host database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE).');
  test.skip(!env.appApiUrl || !env.hostClient, 'APP_API_URL and HOST_CLIENT_ID are needed.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.skip(canSeedLocalDb() && !sinkIsConfigured(), 'EmailSettings MailServer/MailPort do not point at the SMTP sink 127.0.0.1:2525.');
  test.use(signedOut);

  let admin: Qc896UserAdminApi;
  let passwords: HostPasswordApi;
  let activeTyped: string;

  test.beforeAll(async ({ browser, playwright }) => {
    test.skip(!(await MailSink.isListening()), 'The SMTP sink is not listening on 127.0.0.1:2525 (node scripts/smtp-sink.mjs).');
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const probe = await request.get(`${env.appApiUrl}/api/Account/CheckUserEULASign`).catch(() => null);
    test.skip(probe?.status() !== 401, `The host API (APP_API_URL ${env.appApiUrl}) is not running.`);

    removeQc896HostUsers();
    const user = seedQc896Admin();
    const context = await browser.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: { cookies: [], origins: [] } });
    try {
      const identityToken = await identityAccessToken(await context.newPage(), request, user, user.authenticatorKey);
      const exchange = await new HostAccountApi(request).identityExchange(identityToken);
      expect(exchange.status, `identityexchange for ${user.email}`).toBe(200);
      admin = new Qc896UserAdminApi(request, exchange.data!.accessToken);
    } finally {
      await context.close();
    }
    passwords = await HostPasswordApi.open();
  });

  test.afterAll(async () => {
    try {
      await passwords?.close();
      expect(removeQc896HostUsers()).toMatch(/left=0;leftNotifications=0/);
      expect(hostUserCount()).toBe(0);
      expect(identityUserCount()).toBe(0);
    } finally {
      removeQc896Admin();
    }
  });

  test('EMLAPP-03 admin user-create sends the branded EmailUserCreatedAudit email and records it without error', async () => {
    test.skip(!auditRecipientsAreSet(), 'EmailSettings:RecipientEmails is empty, so no audit email is sent.');
    const sinceId = lastNotificationId();
    const since = MailSink.mark();
    const created = await admin.create({ userName: AUDITED, firstName: 'E2E', lastName: 'QC-896 audited', password: newPassword(), isActive: true });
    expect(created.status, `user-create ${AUDITED}: ${created.text}`).toBeLessThan(300);

    await expect
      .poll(() => notificationFor(AUDITED, QC798_AUDIT_TYPE, sinceId), { message: 'an EmailUserCreatedAudit notification is recorded', timeout: 20_000 })
      .not.toBeNull();
    const row = notificationFor(AUDITED, QC798_AUDIT_TYPE, sinceId)!;
    expect(row.errorMessage, 'the audit email has no delivery error').toBe('');
    expect(row.inError).toBe(0);
    expect(row.messageTypeId).toBe(messageTypeId(QC798_AUDIT_TYPE));

    let mail: Email | undefined;
    await expect
      .poll(() => (mail = auditMailsAbout(AUDITED, since).at(-1)) !== undefined, { message: 'the audit email reaches the SMTP sink', timeout: 20_000 })
      .toBe(true);
    const hostName = hostOrganisationName();
    expect(subjectOf(mail!)).toContain(`${hostName}: new user created`);
    expect(mail!.text).toContain('<table');
    expect(mail!.text).toContain(hostName);
    expect(mail!.text).toContain(AUDITED);
    expect(mail!.text, 'every template token is replaced').not.toContain('{{');
    expect(mail!.text).not.toContain('endif}}');
  });

  test('EMLAPP-04 admin user-create sends EmailCreateUser to the new user with a Set your password link and no password', async () => {
    activeTyped = newPassword();
    const sinceId = lastNotificationId();
    const since = MailSink.mark();
    const created = await admin.create({ userName: ACTIVE, firstName: 'E2E', lastName: 'QC-896 active', password: activeTyped, isActive: true });
    expect(created.status, `user-create ${ACTIVE}: ${created.text}`).toBeLessThan(300);

    await expect
      .poll(() => notificationFor(ACTIVE, CREATE_TYPE, sinceId), { message: 'an EmailCreateUser notification is recorded', timeout: 20_000 })
      .not.toBeNull();
    const row = notificationFor(ACTIVE, CREATE_TYPE, sinceId)!;
    expect(row.errorMessage, 'the create-user email has no delivery error').toBe('');
    expect(row.inError).toBe(0);
    expect(row.messageTypeId).toBe(messageTypeId(CREATE_TYPE));

    const mail = await MailSink.latestTo(ACTIVE, since);
    expect(mail.text).toMatch(/Set your password/i);
    expectPasswordLink(mail, ACTIVE, activeTyped);
  });

  test('EMLAPP-05 forgot password for a throwaway active user sends EmailResetPassword with a reset link and no password', async () => {
    test.skip(!activeTyped, 'EMLAPP-04 did not create the active user.');
    const sinceId = lastNotificationId();
    const since = MailSink.mark();
    const forgot = await passwords.forgot(ACTIVE);
    expect(forgot.status, forgot.text).toBe(200);

    await expect
      .poll(() => notificationFor(ACTIVE, RESET_TYPE, sinceId), { message: 'an EmailResetPassword notification is recorded', timeout: 20_000 })
      .not.toBeNull();
    const row = notificationFor(ACTIVE, RESET_TYPE, sinceId)!;
    expect(row.errorMessage, 'the reset email has no delivery error').toBe('');
    expect(row.inError).toBe(0);
    expect(row.messageTypeId).toBe(messageTypeId(RESET_TYPE));

    expectPasswordLink(await MailSink.latestTo(ACTIVE, since), ACTIVE, activeTyped);
  });
});
