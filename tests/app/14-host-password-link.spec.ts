// QC-800: the host API emails a single-use link instead of setting or emailing a password. Local only.
// Needs the SMTP sink (`node scripts/smtp-sink.mjs`, 127.0.0.1:2525, writes reports/local/mail/*.eml) and the host's
// app.EnvironmentSetting EmailSettings MailServer = 127.0.0.1 and MailPort = 2525 (rows 8 and 9), with the host API restarted
// after the change. The sink has no TLS: when EmailSettings:UserName and Password are both set (an empty table value does not
// override appsettings.Development.json) FluentEmail turns SSL on and every send fails, so start the API with
// --EmailSettings:UserName= ; otherwise the cases that need a delivered email skip with that error.
// Signs in as the QC-804 throwaway host admin to call user-create; every e2e.qc800.*@example.com user is removed by
// seed/host-qc800.remove.sql. forgotpassword and resetpassword share 5 requests a minute per IP, so calls are paced and
// HPWD-08 runs last.
import * as crypto from 'crypto';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue } from '@utils/localDb';
import { CommsHostAdmin, QC804_ADMIN_EMAIL } from '@pages/comms-send-gate.page';
import {
  FORGOT_TOAST,
  ForgotPasswordPage,
  HostPasswordApi,
  HostUserAdminApi,
  INVALID_RESET,
  LINK_USED,
  MailSink,
  PASSWORD_LIMIT_PER_MINUTE,
  PASSWORD_SET,
  PasswordRequestPacer,
  Qc800HostUsers,
  RESET_EMAIL_SENT,
  ResetPasswordPage,
  passwordLinkIn,
  qc800Email,
  tamper,
  type Email,
  type PasswordLinkUrl,
} from '@pages/host-password-link.page';

const ACTIVE = qc800Email('hpwd-active');
const INACTIVE = qc800Email('hpwd-inactive');
const CREATED = qc800Email('hpwd-created');
const UNKNOWN = qc800Email('hpwd-nobody');

function newPassword(): string {
  return `Qc800!${crypto.randomBytes(5).toString('hex')}`;
}

function sinkIsConfigured(): boolean {
  return (
    querySingleValue(
      `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings'
       AND ((PropertyName = N'MailServer' AND PropertyValue = N'127.0.0.1') OR (PropertyName = N'MailPort' AND PropertyValue = N'2525'))`,
    ) === '2'
  );
}

async function appIsUp(): Promise<boolean> {
  if (!env.appUrl) return false;
  return fetch(env.appUrl)
    .then((r) => r.ok)
    .catch(() => false);
}

function expectNoPassword(mail: Email, ...passwords: string[]): void {
  for (const password of passwords) expect(mail.text, `${mail.file} does not contain a password`).not.toContain(password);
  expect(mail.text).not.toMatch(/\{\{\s*Password\s*\}\}/i);
  expect(mail.text).not.toMatch(/(temporary|new)\s+password\s*(is)?\s*:/i);
}

test.describe('Host password emails carry a single-use link (QC-800)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb(), 'Needs the local host database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE).');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the QC-804 throwaway host admin.");
  test.skip(canSeedLocalDb() && !sinkIsConfigured(), 'EmailSettings MailServer/MailPort do not point at the SMTP sink 127.0.0.1:2525.');
  test.use(signedOut);

  let api: HostPasswordApi;
  let admin: HostUserAdminApi;
  let mailError: string | null = 'beforeAll did not run';
  const passwords: Record<string, string> = {};
  const mails: Partial<Record<'forgot' | 'created', Email>> = {};
  let createdSince: Set<string>;
  let createdTyped: string;
  let firstLink: PasswordLinkUrl;
  let freshLink: PasswordLinkUrl;

  function needsDeliveredMail(): void {
    test.skip(mailError !== null, `The host API did not deliver its email to the SMTP sink: ${mailError}`);
  }

  test.beforeAll(async ({ browser }) => {
    test.skip(!(await MailSink.isListening()), 'The SMTP sink is not listening on 127.0.0.1:2525 (node scripts/smtp-sink.mjs).');
    test.skip(!(await appIsUp()), `The host app is not running on ${env.appUrl}.`);
    Qc800HostUsers.remove();
    await CommsHostAdmin.signIn(browser);
    api = await HostPasswordApi.open();
    admin = await HostUserAdminApi.open();
    expect((await api.forgot(UNKNOWN)).status, 'a paced request goes through once any earlier window has passed').toBe(200);

    const since = MailSink.mark();
    for (const [email, isActive] of [
      [ACTIVE, true],
      [INACTIVE, false],
    ] as const) {
      const created = await admin.create({ userName: email, firstName: 'E2E', lastName: 'QC-800', password: newPassword(), isActive });
      expect(created.status, `user-create ${email}: ${created.text}`).toBeLessThan(300);
    }
    mailError = Qc800HostUsers.deliveryError(ACTIVE, 'EmailCreateUser');
    if (mailError !== null) return;

    const link = passwordLinkIn(await MailSink.latestTo(ACTIVE, since));
    passwords.current = newPassword();
    const set = await api.reset(link.email, link.code, passwords.current);
    expect(set.status, set.text).toBe(200);
  });

  test.afterAll(async () => {
    try {
      await api?.close();
      await admin?.close();
      const output = Qc800HostUsers.remove();
      expect(output).toMatch(/left=0/);
    } finally {
      CommsHostAdmin.remove();
    }
  });

  test('HPWD-01 Forgot password for an active user emails a reset link with no password and leaves the password as it was', async ({ page }) => {
    needsDeliveredMail();
    const before = Qc800HostUsers.password(ACTIVE);
    const since = MailSink.mark();
    const forgot = new ForgotPasswordPage(page);
    await forgot.open();
    await expect(forgot.send).toHaveText('Send Reset Link');
    await forgot.requestLink(ACTIVE);
    await expect(forgot.toast).toContainText(FORGOT_TOAST);

    const mail = await MailSink.latestTo(ACTIVE, since);
    mails.forgot = mail;
    firstLink = passwordLinkIn(mail);
    expect(firstLink.email).toBe(ACTIVE);
    expect(firstLink.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(new URL(firstLink.raw).pathname).toBe('/authentication/reset-password');
    expectNoPassword(mail, passwords.current);

    expect(Qc800HostUsers.password(ACTIVE)).toEqual(before);
    expect(await api.login(ACTIVE, passwords.current)).toBe(200);
  });

  test('HPWD-02 the emailed link opens Set Your Password in the app and sets a new password; the old one stops working', async ({ page }) => {
    needsDeliveredMail();
    const reset = new ResetPasswordPage(page);
    await reset.open(firstLink);
    await expect(reset.title).toHaveText('Set Your Password');
    await expect(reset.submit).toHaveText('Set Password');
    const next = newPassword();
    await reset.setPassword(next);
    await expect(reset.success).toHaveText(PASSWORD_SET);

    expect(await api.login(ACTIVE, passwords.current)).toBe(401);
    passwords.current = next;
    expect(await api.login(ACTIVE, passwords.current)).toBe(200);
  });

  test('HPWD-03 a link that was used is refused by the API and the app shows it as expired or used', async ({ page }) => {
    needsDeliveredMail();
    const before = Qc800HostUsers.password(ACTIVE);
    const again = await api.reset(firstLink.email, firstLink.code, newPassword());
    expect(again.status, again.text).toBe(400);
    expect(again.body?.errors).toEqual([INVALID_RESET]);

    const reset = new ResetPasswordPage(page);
    await reset.open(firstLink);
    await reset.setPassword(newPassword());
    await expect(reset.error).toContainText(LINK_USED);
    await expect(reset.requestNewLink).toBeVisible();
    await expect(reset.requestNewLink).toHaveText('Request a new link');

    expect(Qc800HostUsers.password(ACTIVE)).toEqual(before);
    expect(await api.login(ACTIVE, passwords.current)).toBe(200);
  });

  test("HPWD-04 a tampered code and a valid code sent with another user's email are refused and change nothing", async () => {
    needsDeliveredMail();
    const since = MailSink.mark();
    const forgot = await api.forgot(ACTIVE);
    expect(forgot.status, forgot.text).toBe(200);
    freshLink = passwordLinkIn(await MailSink.latestTo(ACTIVE, since));
    const before = Qc800HostUsers.password(ACTIVE);

    const tampered = await api.reset(ACTIVE, tamper(freshLink.code), newPassword());
    expect(tampered.status, tampered.text).toBe(400);
    expect(tampered.body?.errors).toEqual([INVALID_RESET]);

    const otherUser = await api.reset(QC804_ADMIN_EMAIL, freshLink.code, newPassword());
    expect(otherUser.status, otherUser.text).toBe(400);
    expect(otherUser.body?.errors).toEqual([INVALID_RESET]);

    expect(Qc800HostUsers.password(ACTIVE)).toEqual(before);
    expect(await api.login(ACTIVE, passwords.current)).toBe(200);
  });

  test('HPWD-05 unknown and inactive addresses get the same 200 answer, no email and no notification', async () => {
    const since = MailSink.mark();
    const notified = [Qc800HostUsers.notificationCount(UNKNOWN), Qc800HostUsers.notificationCount(INACTIVE)];
    const unknown = await api.forgot(UNKNOWN);
    const inactive = await api.forgot(INACTIVE);

    expect(unknown.status, unknown.text).toBe(200);
    expect(unknown.body?.message).toBe(RESET_EMAIL_SENT);
    expect(inactive.status).toBe(unknown.status);
    expect(inactive.text).toBe(unknown.text);

    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(MailSink.newTo(UNKNOWN, since)).toEqual([]);
    expect(MailSink.newTo(INACTIVE, since)).toEqual([]);
    expect([Qc800HostUsers.notificationCount(UNKNOWN), Qc800HostUsers.notificationCount(INACTIVE)], 'no notification is recorded for either').toEqual(notified);
  });

  test('HPWD-06 a password that breaks the policy is refused with validationErrors and the link still works afterwards, clearing a lockout', async () => {
    needsDeliveredMail();
    const before = Qc800HostUsers.password(ACTIVE);
    const weak = await api.reset(ACTIVE, freshLink.code, 'short');
    expect(weak.status, weak.text).toBe(400);
    expect(Object.keys(weak.body?.validationErrors ?? {}).map((key) => key.toLowerCase())).toContain('password');
    expect(Object.values(weak.body?.validationErrors ?? {}).flat().length).toBeGreaterThan(0);
    expect(Qc800HostUsers.password(ACTIVE)).toEqual(before);

    Qc800HostUsers.lockOut(ACTIVE);
    expect(Qc800HostUsers.lockout(ACTIVE)).toBe('3|1');

    const next = newPassword();
    const good = await api.reset(ACTIVE, freshLink.code, next);
    expect(good.status, good.text).toBe(200);
    expect(Qc800HostUsers.lockout(ACTIVE)).toBe('0|0');
    passwords.current = next;
    expect(await api.login(ACTIVE, passwords.current)).toBe(200);
  });

  test('HPWD-07 admin user-create ignores a typed password: no password is stored, the typed one cannot sign in, and a private Set your password email is recorded', async () => {
    createdTyped = newPassword();
    createdSince = MailSink.mark();
    const created = await admin.create({ userName: CREATED, firstName: 'E2E', lastName: 'QC-800 created', password: createdTyped, isActive: true });
    expect(created.status, created.text).toBeLessThan(300);

    expect(Qc800HostUsers.password(CREATED).passwordHash).toBeNull();
    expect(await api.login(CREATED, createdTyped)).toBe(401);
    expect(Qc800HostUsers.notificationCount(CREATED)).toBe(1);
    expect(Qc800HostUsers.latestNotification(CREATED, 'EmailCreateUser').messageBody).toBe('EMPTY');
  });

  test('HPWD-09 the auth.SystemNotifications rows of both password emails keep no body and no Bcc', async () => {
    test.info().annotations.push({
      type: 'host bcc',
      description: Qc800HostUsers.hostBccIsSet() ? 'EmailSettings:bcc is set, so other emails are copied' : 'EmailSettings:bcc is empty',
    });
    expect(Qc800HostUsers.latestNotification(CREATED, 'EmailCreateUser')).toEqual({ messageBody: 'EMPTY', bcc: null });
    expect(Qc800HostUsers.latestNotification(ACTIVE, 'EmailCreateUser')).toEqual({ messageBody: 'EMPTY', bcc: null });
    const forgot = await api.forgot(ACTIVE);
    expect(forgot.status, forgot.text).toBe(200);
    expect(Qc800HostUsers.latestNotification(ACTIVE, 'EmailResetPassword')).toEqual({ messageBody: 'EMPTY', bcc: null });
  });

  test('HPWD-10 the Set your password email has a link and no password, and the link sets a password that signs in', async () => {
    needsDeliveredMail();
    const mail = await MailSink.latestTo(CREATED, createdSince);
    mails.created = mail;
    expect(mail.text).toMatch(/Set your password/i);
    expectNoPassword(mail, createdTyped);
    const link = passwordLinkIn(mail);
    expect(link.email).toBe(CREATED);

    const chosen = newPassword();
    const set = await api.reset(link.email, link.code, chosen);
    expect(set.status, set.text).toBe(200);
    expect(await api.login(CREATED, chosen)).toBe(200);
    expect(await api.login(CREATED, createdTyped)).toBe(401);
  });

  test('HPWD-11 neither delivered password email has a Bcc or Cc header', () => {
    needsDeliveredMail();
    expect(mails.forgot && mails.created, 'HPWD-01 and HPWD-10 captured both emails').toBeTruthy();
    for (const mail of [mails.forgot!, mails.created!]) {
      expect(mail.headers.has('bcc'), `${mail.file} has no Bcc header`).toBe(false);
      expect(mail.headers.has('cc'), `${mail.file} has no Cc header`).toBe(false);
    }
  });

  test('HPWD-12 the app pages read Send Reset Link and Set Your Password, and a bad link is shown as expired or used with Request a new link', async ({
    page,
  }) => {
    const forgot = new ForgotPasswordPage(page);
    await forgot.open();
    await expect(forgot.send).toHaveText('Send Reset Link');
    await forgot.requestLink(UNKNOWN);
    await expect(forgot.toast).toContainText(FORGOT_TOAST);
    await expect(page, 'the forgot page moves on to sign-in after its toast').not.toHaveURL(/forgot-password/, { timeout: 15_000 });

    const reset = new ResetPasswordPage(page);
    await reset.open({
      raw: `http://localhost/authentication/reset-password?email=${encodeURIComponent(ACTIVE)}&code=bm90LWEtdG9rZW4`,
      email: ACTIVE,
      code: 'bm90LWEtdG9rZW4',
    });
    await expect(reset.title).toHaveText('Set Your Password');
    await expect(reset.submit).toHaveText('Set Password');
    await reset.setPassword(newPassword());
    await expect(reset.error).toContainText(LINK_USED);
    await expect(reset.requestNewLink).toHaveText('Request a new link');
    await reset.requestNewLink.click();
    await expect(forgot.email).toBeVisible();
  });

  test('HPWD-08 a 6th forgot/reset request from one IP within a minute is refused with 429 and Retry-After', async () => {
    await PasswordRequestPacer.waitForEmptyWindow();
    const statuses: number[] = [];
    for (let i = 0; i < PASSWORD_LIMIT_PER_MINUTE; i++) statuses.push((await api.forgot(UNKNOWN, false)).status);
    expect(statuses).toEqual(Array(PASSWORD_LIMIT_PER_MINUTE).fill(200));

    const reset = await api.reset(UNKNOWN, 'x', newPassword(), false);
    expect(reset.status, reset.text).toBe(429);
    expect(Number(reset.retryAfter)).toBeGreaterThan(0);
    expect(Number(reset.retryAfter)).toBeLessThanOrEqual(60);
    expect(reset.body?.errors?.join(' ')).toMatch(/Too many password requests/);

    const forgot = await api.forgot(UNKNOWN, false);
    expect(forgot.status).toBe(429);
    expect(forgot.retryAfter).not.toBeNull();
  });
});
