// QC-913 (D77/D83): Manage Users and the Vendor Portal create users with no password and invite them through Identity.
// Local only. Runs against a host API built from QC-913 (APP_API_URL), its database (LOCAL_SQL_DATABASE with app.UserInvites),
// an Identity that reads the host's invite public key from HOST_MASTER (IDENTITY_URL, MASTER_SQL_DATABASE), and the drivers API.
// The host API must get Invites:SigningKey (a private EC P-256 JWK) from an environment variable (Invites__SigningKey) or user
// secrets, since it no longer reads it from app.EnvironmentSetting; it needs EmailSettings:ApiPublicUrl = APP_API_URL, a return URL
// APP_API_URL/api/invites/return in HOST_MASTER, and EmailSettings MailServer/MailPort pointing at the SMTP sink
// (`node scripts/smtp-sink.mjs <SMTP_SINK_PORT>`, which writes reports/local/mail/*.eml). HOST_API_LOG (the host API's console
// log file) lets UINV-09 check that LinkEstablished came back; without it that one check is skipped.
// Signs in as a throwaway host Admin e2e.qc913.admin@example.com (two-step, the password of ADMIN_EMAIL; seed/identity-qc913-user.apply.sql
// and seed/host-qc913-admin.apply.sql), whose session is kept in <AUTH_DIR>/<env>/qc913-app-admin.json.
// Every e2e.qc913.*@example.com host user, invite, notification, Identity login and DRIVERS link is removed before and after
// by seed/host-qc913.remove.sql, seed/identity-qc913.remove.sql and seed/drivers-qc913.remove.sql.
// UINV-13/14 switch the host's Authentication:SignInMode (QC-956) to Legacy through PUT api/environment-setting with the Admin
// service client (ADMIN_API_CLIENT_ID/SECRET, which the host API must list in IdentityServer:AdminClientIds), and put the
// original mode and the row's UpdatedBy/UpdatedOn back in finally.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Browser } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { AUTH_DIR, env } from '@config/env.config';
import { HostDriversMode } from '@api/sms-routing.api';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb } from '@utils/localDb';
import { INVITE_AUDIENCE, INVITE_TYPE, newInviteKeyPair, signInviteLink } from '@utils/inviteLinks';
import { MailSink } from '@pages/host-password-link.page';
import { InviteeBrowser, VendorPortalSession, saveHostAppSession } from '@pages/user-invites.page';
import {
  ALREADY_LINKED_MESSAGE,
  CREATE_USER_EMAIL_TYPE,
  INACTIVE_MESSAGE,
  INVALID_ANSWER_MESSAGE,
  NOT_SENT_MESSAGE,
  INVITE_EMAIL_TYPE,
  INVITE_LIFETIME_HOURS,
  INVITE_ROW_STATUS,
  INVITE_SENT_MESSAGE,
  LEGACY_USER_CREATED_MESSAGE,
  PASSWORD_SIGN_IN_MESSAGE,
  Qc913Data,
  SIGN_IN_MODE_KEY,
  USER_CREATED_MESSAGE,
  identityAcceptsLink,
  inviteEmailTo,
  mailsTo,
  qc913Email,
  removeQc913Data,
  seedQc913HostAdmin,
  seedQc913Login,
  seedQc913Vendor,
  type HostSignInMode,
  type HostUserInvitesApi,
  type InviteEmail,
  type SignInMode,
} from '@api/user-invites.api';
import type { ThrowawayUser } from '@utils/throwawayUsers';

const ADMIN_STATE = path.join(AUTH_DIR, env.name, 'qc913-app-admin.json');
const NEW_USER = { email: qc913Email('created'), firstName: 'Nina', lastName: 'Invited' };
const DRIVER = { email: qc913Email('driver'), firstName: 'Dan', lastName: 'Driver' };
const DRIVER_MODE_OFF = { email: qc913Email('driver-off'), firstName: 'Olga', lastName: 'Driver' };

function newPassword(): string {
  return `Qc913!${crypto.randomBytes(6).toString('hex')}Aa1`;
}

async function hostIsUp(): Promise<boolean> {
  return fetch(`${env.appUrl}`)
    .then((r) => r.ok)
    .catch(() => false);
}

let vendorLogin: ThrowawayUser | undefined;

/** The QC-913 vendor login, its organisation and two trucks, seeded once per run (re-seeding would remove trucks a driver is on). */
function qc913Vendor(): ThrowawayUser {
  if (!vendorLogin) {
    vendorLogin = seedQc913Login('vendor', true);
    seedQc913Vendor(vendorLogin);
  }
  return vendorLogin;
}

/** Runs `body` with the host in Legacy sign-in mode, then puts the original mode and the setting row's audit columns back. */
async function inLegacyMode(signInMode: HostSignInMode, body: () => Promise<void>): Promise<void> {
  test.skip(
    !env.adminApiClient,
    'Needs ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET, the Admin service client the host API takes on api/environment-setting.',
  );
  const original = (await signInMode.current()) as SignInMode | null;
  expect(original, 'the host API answers its sign-in mode').not.toBeNull();
  const audit = Qc913Data.settingAudit(SIGN_IN_MODE_KEY);
  try {
    await signInMode.set('Legacy');
    await body();
  } finally {
    await signInMode.set(original!);
    Qc913Data.restoreSettingAudit(SIGN_IN_MODE_KEY, audit);
  }
  expect(Qc913Data.settingValue(SIGN_IN_MODE_KEY), 'the sign-in mode is back in app.EnvironmentSetting').toBe(original);
}

let deliveryError: string | null = null;
let hostLogMark = 0;
const SMTP_FAILURE = 'The email was not successfully sent';

/** Skips the case when an earlier send showed that the host API cannot deliver email to the sink (an environment problem). */
function needsDelivery(): void {
  test.skip(deliveryError !== null, `The host API could not deliver the invite email to the SMTP sink: ${deliveryError}`);
}

/**
 * Checks the answer of a Send invite. A 400 "The invite email could not be sent" is skipped as an environment problem only
 * when the host log (HOST_API_LOG) shows the SMTP send failing since this case began, or when there is no log to tell;
 * any other cause in the log (for example the link signing failing) fails the case with that log line.
 */
function expectInviteSent(sent: { status: number; text: string }): void {
  if (sent.status === 400 && sent.text.includes(NOT_SENT_MESSAGE)) {
    const log = Qc913Data.hostLogSince(hostLogMark);
    if (log === null || log.includes(SMTP_FAILURE)) {
      deliveryError = `${NOT_SENT_MESSAGE} (${log === null ? 'HOST_API_LOG is not set to tell why' : 'the host log shows the SMTP send failing'})`;
      needsDelivery();
    }
    const cause = (log ?? '').split(/\r?\n/).find((line) => /UserInviteModelFactory|Exception/.test(line)) ?? '';
    expect(sent.status, `${sent.text} | host log: ${cause.replace(/^.*\(QuarryConnect\.WebApi\) /, '').slice(0, 400)}`).toBe(200);
  }
  expect(sent.status, sent.text).toBe(200);
}

async function createAndInvite(api: HostUserInvitesApi, name: string, firstName: string): Promise<{ email: string; userId: string; mail: InviteEmail }> {
  needsDelivery();
  const email = qc913Email(name);
  const created = await api.createUser({ userName: email, firstName, lastName: 'QC-913' });
  expect(created.status, `user-create ${email}: ${created.text}`).toBe(201);
  const userId = created.data!;
  const since = MailSink.mark();
  const sent = await api.sendInvite('manageusers', userId);
  expectInviteSent(sent);
  return { email, userId, mail: await inviteEmailTo(email, since) };
}

test.describe('Host user invites from Manage Users and the Vendor Portal (QC-913)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's and Identity's local databases (local only).");
  test.skip(!env.appApiUrl || !env.appUrl, 'APP_URL and APP_API_URL are needed.');
  test.skip(canSeedLocalDb() && !Qc913Data.hostHasTable('app.UserInvites'), 'The host database has no app.UserInvites (QC-913 migration 202611111200).');
  test.skip(
    canSeedLocalDb() && !Qc913Data.sinkIsConfigured(),
    `EmailSettings MailServer/MailPort do not point at the SMTP sink 127.0.0.1:${env.smtpSinkPort}.`,
  );
  test.skip(canSeedLocalDb() && !Qc913Data.invitesAreSetUp(), 'EmailSettings:ApiPublicUrl is not APP_API_URL.');
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway host admin copies that password.');
  test.use({ storageState: ADMIN_STATE });

  let api: HostUserInvitesApi;
  const created: { userId?: string; mail?: InviteEmail; password?: string; sub?: string } = {};

  test.beforeAll(async ({ browser }) => {
    test.skip(
      !(await MailSink.isListening()),
      `The SMTP sink is not listening on 127.0.0.1:${env.smtpSinkPort} (node scripts/smtp-sink.mjs ${env.smtpSinkPort}).`,
    );
    test.skip(!(await hostIsUp()), `The host app is not running on ${env.appUrl}.`);
    removeQc913Data();
    const admin = seedQc913Login('admin', true);
    seedQc913HostAdmin(admin);
    await saveHostAppSession(browser, admin, ADMIN_STATE);
  });

  test.beforeEach(({ hostUserInvitesApi }) => {
    api = hostUserInvitesApi.useSession(ADMIN_STATE);
    hostLogMark = Qc913Data.hostLogMark();
  });

  test.afterAll(() => {
    fs.rmSync(ADMIN_STATE, { force: true });
    const removed = removeQc913Data();
    expect(removed.host).toMatch(/left=0;leftInvites=0;leftNotifications=0;leftOrganisations=0/);
    expect(removed.identity).toMatch(/left=0/);
    if (removed.drivers !== null) expect(removed.drivers).toMatch(/leftLinks=0/);
  });

  test('UINV-01 Create New User has no password fields; Save opens the new user with "Not invited" and Send invite, stores no password and sends no EmailCreateUser', async ({
    adminUserFormPage,
  }) => {
    const since = MailSink.mark();
    await adminUserFormPage.open();
    await adminUserFormPage.expectNoPasswordFields();
    await expect(adminUserFormPage.createHint).toBeVisible();
    await expect(adminUserFormPage.signIn.send).toHaveCount(0);

    await adminUserFormPage.fillPerson(NEW_USER.email, NEW_USER.firstName, NEW_USER.lastName);
    await adminUserFormPage.chooseRole('Sales');
    created.userId = await adminUserFormPage.saveNew();
    await adminUserFormPage.expectToast(USER_CREATED_MESSAGE);
    await adminUserFormPage.expectNoPasswordFields();
    await adminUserFormPage.signIn.expectStatus('not-invited');
    await adminUserFormPage.signIn.expectSendButton('Send invite');

    expect(Qc913Data.hostUser(NEW_USER.email)).toMatchObject({ id: created.userId, userUuid: null, hasPassword: false, isActive: true });
    expect(Qc913Data.invites(created.userId)).toEqual([]);
    if (Qc913Data.auditEmailIsSetUp()) {
      await expect.poll(() => Qc913Data.auditNotificationCount(NEW_USER.email), { message: 'the staff audit email is still sent', timeout: 20_000 }).toBe(1);
    } else {
      test.info().annotations.push({
        type: 'skipped check',
        description: 'EmailSettings:RecipientEmails is empty or the EmailUserCreatedAudit template is missing, so the audit email was not checked.',
      });
    }
    expect(Qc913Data.notificationCount(NEW_USER.email, CREATE_USER_EMAIL_TYPE), 'no EmailCreateUser notification').toBe(0);
    expect(Qc913Data.notificationCount(NEW_USER.email), 'nothing at all is sent to the new user').toBe(0);
    expect(mailsTo(NEW_USER.email, since), 'no email reaches the new user').toEqual([]);
  });

  test('UINV-02 Send invite shows Invited with sent and expiry dates and Resend invite, records the invite, and emails a Host-signed Accept invite link and a decline link', async ({
    adminUserFormPage,
  }) => {
    test.skip(!created.userId, 'UINV-01 did not create the user.');
    const since = MailSink.mark();
    await adminUserFormPage.open(created.userId);
    expectInviteSent(await adminUserFormPage.signIn.sendInvite());
    await adminUserFormPage.signIn.expectToast(INVITE_SENT_MESSAGE);
    await adminUserFormPage.signIn.expectStatus('invited');
    await adminUserFormPage.signIn.expectSentAndExpires();
    await adminUserFormPage.signIn.expectSendButton('Resend invite');

    const [row] = Qc913Data.invites(created.userId!);
    expect(row).toMatchObject({
      email: NEW_USER.email,
      userType: 'host',
      status: INVITE_ROW_STATUS.sent,
      replaces: null,
      acceptedUserUuid: null,
      responded: false,
    });
    expect(row.expiresInMinutes).toBeGreaterThan(INVITE_LIFETIME_HOURS * 60 - 5);
    expect(row.expiresInMinutes).toBeLessThanOrEqual(INVITE_LIFETIME_HOURS * 60);

    const mail = await inviteEmailTo(NEW_USER.email, since);
    created.mail = mail;
    expect(mail.subject).toMatch(/^\S.* New Account Created$/);
    expect(mail.mail.text).toContain(`Hi ${NEW_USER.firstName},`);
    expect(mail.mail.text, 'every template token is replaced').not.toContain('{{');
    expect(mail.mail.headers.has('bcc'), 'the invite email has no Bcc header').toBe(false);
    expect(mail.mail.headers.has('cc'), 'the invite email has no Cc header').toBe(false);
    expect(new URL(mail.declineUrl).searchParams.get('t'), 'both links carry the same signed token').toBe(mail.link.token);

    const { header, payload } = mail.link;
    expect(header).toMatchObject({ alg: 'ES256', typ: INVITE_TYPE });
    expect(header.kid).toBeTruthy();
    expect(payload).toMatchObject({
      iss: expect.stringMatching(new RegExp(`^${Qc913Data.hostUuid()}$`, 'i')),
      aud: INVITE_AUDIENCE,
      jti: row.uuid,
      email: NEW_USER.email,
      given_name: NEW_USER.firstName,
      family_name: NEW_USER.lastName,
      user_type: 'host',
      return_url: `${env.appApiUrl}/api/invites/return`,
    });
    expect(payload.exp - payload.iat).toBeGreaterThan(INVITE_LIFETIME_HOURS * 3600 - 300);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(INVITE_LIFETIME_HOURS * 3600);

    const notification = Qc913Data.latestInviteNotification(NEW_USER.email);
    expect(notification, 'the invite email is recorded without a delivery error').toMatchObject({ inError: 0, error: '' });
    expect(['EMPTY', 'NULL'], 'the private invite email keeps no body').toContain(notification!.body);
    expect(notification!.bcc, 'the private invite email gets no Bcc').toBeNull();
    expect(Qc913Data.notificationCount(NEW_USER.email, CREATE_USER_EMAIL_TYPE)).toBe(0);
  });

  test('UINV-03 accepting as a new login on Identity is recorded by the host: UserUUID = the Identity sub, invite accepted, Linked with no Send button, and the login signs in to the host app', async ({
    browser,
    adminUserFormPage,
  }) => {
    test.skip(!created.mail, 'UINV-02 did not send the invite.');
    const invitee = await InviteeBrowser.open(browser);
    created.password = newPassword();
    try {
      const outcome = await invitee.acceptAsNew(created.mail!.acceptUrl, { ...NEW_USER, password: created.password });
      expect(outcome.status, 'the host recorded the answer').toBe('recorded');
      await invitee.invite.expectSetupComplete(false);
    } finally {
      await invitee.close();
    }

    created.sub = Qc913Data.identityUserUuid(NEW_USER.email) ?? undefined;
    expect(created.sub, 'Identity made the login').toMatch(/^[0-9a-f-]{36}$/);
    expect(Qc913Data.hostUser(NEW_USER.email)).toMatchObject({ id: created.userId, userUuid: created.sub, emailConfirmed: true, hasPassword: false });
    expect(Qc913Data.invites(created.userId!)).toEqual([
      expect.objectContaining({ status: INVITE_ROW_STATUS.accepted, acceptedUserUuid: created.sub, responded: true }),
    ]);

    await adminUserFormPage.open(created.userId);
    await adminUserFormPage.signIn.expectStatus('linked');
    await adminUserFormPage.signIn.expectNoSendButton();
    await expect(adminUserFormPage.signIn.sentAt).toHaveCount(0);

    const again = await api.sendInvite('manageusers', created.userId!);
    expect(again.status, again.text).toBe(400);
    expect(again.text).toContain(ALREADY_LINKED_MESSAGE);

    const signIn = await InviteeBrowser.open(browser);
    try {
      await signIn.signInToHostApp({ email: NEW_USER.email, password: created.password });
    } finally {
      await signIn.close();
    }
  });

  test('UINV-04 a person who already has an Identity login signs in from the link, confirms Accept invite, and the host user is linked to that login', async ({
    browser,
  }) => {
    needsDelivery();
    const login: ThrowawayUser = seedQc913Login('existing', false);
    const created = await api.createUser({ userName: login.email, firstName: 'Ezra', lastName: 'Existing' });
    expect(created.status, created.text).toBe(201);
    const since = MailSink.mark();
    const sent = await api.sendInvite('manageusers', created.data!);
    expectInviteSent(sent);
    const mail = await inviteEmailTo(login.email, since);

    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.acceptAsExisting(mail.acceptUrl, login);
      expect(outcome.status).toBe('recorded');
      await invitee.invite.expectSetupComplete(false);
    } finally {
      await invitee.close();
    }

    expect(Qc913Data.hostUser(login.email)).toMatchObject({ id: created.data, userUuid: login.userId.toLowerCase(), emailConfirmed: true });
    expect(Qc913Data.invites(created.data!)).toEqual([
      expect.objectContaining({ status: INVITE_ROW_STATUS.accepted, acceptedUserUuid: login.userId.toLowerCase() }),
    ]);
  });

  test('UINV-05 the email decline link declines: Identity says the host has been told, the host shows Declined with its date and Resend invite, and no login is made', async ({
    browser,
    adminUserFormPage,
  }) => {
    const user = await createAndInvite(api, 'declined', 'Della');
    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.decline(user.mail.declineUrl);
      expect(outcome.status).toBe('recorded');
      await invitee.invite.expectDeclined(outcome.hostName);
    } finally {
      await invitee.close();
    }

    expect(Qc913Data.invites(user.userId)).toEqual([expect.objectContaining({ status: INVITE_ROW_STATUS.declined, responded: true, acceptedUserUuid: null })]);
    expect(Qc913Data.hostUser(user.email)).toMatchObject({ userUuid: null });
    expect(Qc913Data.identityUserUuid(user.email), 'no Identity login').toBeNull();

    await adminUserFormPage.open(user.userId);
    await adminUserFormPage.signIn.expectStatus('declined');
    await expect(adminUserFormPage.signIn.declinedAt).toHaveText(/^Declined \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/);
    await adminUserFormPage.signIn.expectSendButton('Resend invite');
    expect((await api.editForm('manageusers', user.userId)).data?.invite).toMatchObject({ status: 'declined', canSend: true });
  });

  test('UINV-06 an invite past ExpiresAt shows Expired; answering its link is refused by the host and Identity shows the expired text; Resend sends a new invite that replaces it', async ({
    browser,
    adminUserFormPage,
  }) => {
    const user = await createAndInvite(api, 'expired', 'Evan');
    const [first] = Qc913Data.invites(user.userId);
    Qc913Data.backdateInvite(first.uuid);

    await adminUserFormPage.open(user.userId);
    await adminUserFormPage.signIn.expectStatus('expired');
    await adminUserFormPage.signIn.expectSentAndExpires();
    await adminUserFormPage.signIn.expectSendButton('Resend invite');
    expect((await api.editForm('manageusers', user.userId)).data?.invite).toMatchObject({ status: 'expired', canSend: true });

    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.decline(user.mail.declineUrl);
      expect(outcome.status, 'the host answers expired for an invite past its ExpiresAt').toBe('expired');
      await invitee.invite.expectFailed();
    } finally {
      await invitee.close();
    }
    expect(Qc913Data.invites(user.userId)).toEqual([expect.objectContaining({ uuid: first.uuid, status: INVITE_ROW_STATUS.sent, responded: false })]);

    const since = MailSink.mark();
    expectInviteSent(await adminUserFormPage.signIn.sendInvite());
    await expect(adminUserFormPage.signIn.resendDialog.root, 'an expired invite is resent without asking').toHaveCount(0);
    await adminUserFormPage.signIn.expectStatus('invited');
    const resent = await inviteEmailTo(user.email, since);
    expect(resent.link.payload.jti).not.toBe(first.uuid);
    expect(Qc913Data.invites(user.userId)).toEqual([
      expect.objectContaining({ uuid: first.uuid, status: INVITE_ROW_STATUS.cancelled }),
      expect.objectContaining({ uuid: resent.link.payload.jti, status: INVITE_ROW_STATUS.sent, replaces: first.uuid }),
    ]);
  });

  test('UINV-07 Resend invite cancels the old invite (Status 40) so its link is refused, and the new link, which points back to it, accepts', async ({
    browser,
    adminUserFormPage,
  }) => {
    const user = await createAndInvite(api, 'resent', 'Rhea');
    const old = user.mail;
    const since = MailSink.mark();
    await adminUserFormPage.open(user.userId);
    await adminUserFormPage.signIn.pressResend();
    expectInviteSent(await adminUserFormPage.signIn.confirmResend());
    await adminUserFormPage.signIn.expectStatus('invited');
    const fresh = await inviteEmailTo(user.email, since);
    expect(fresh.link.payload.jti).not.toBe(old.link.payload.jti);
    expect(Qc913Data.invites(user.userId)).toEqual([
      expect.objectContaining({ uuid: old.link.payload.jti, status: INVITE_ROW_STATUS.cancelled }),
      expect.objectContaining({ uuid: fresh.link.payload.jti, status: INVITE_ROW_STATUS.sent, replaces: old.link.payload.jti }),
    ]);

    const invitee = await InviteeBrowser.open(browser);
    try {
      const refused = await invitee.decline(old.declineUrl);
      expect(refused.status, 'the cancelled invite is not recorded').toBe('expired');
      await invitee.invite.expectFailed();

      const accepted = await invitee.acceptAsNew(fresh.acceptUrl, { email: user.email, firstName: 'Rhea', lastName: 'QC-913', password: newPassword() });
      expect(accepted.status).toBe('recorded');
    } finally {
      await invitee.close();
    }
    const sub = Qc913Data.identityUserUuid(user.email);
    expect(Qc913Data.hostUser(user.email)?.userUuid).toBe(sub);
    expect(Qc913Data.invites(user.userId).map((row) => row.status)).toEqual([INVITE_ROW_STATUS.cancelled, INVITE_ROW_STATUS.accepted]);
  });

  test('UINV-08 changing the email of an invited user cancels the open invite and sends a new one to the new address only', async ({
    adminUserFormPage,
    hostUserEmailField,
  }) => {
    const user = await createAndInvite(api, 'moved-from', 'Milo');
    const moved = qc913Email('moved-to');
    const since = MailSink.mark();
    await adminUserFormPage.open(user.userId);
    await hostUserEmailField.expectEditable(user.email);
    expect(await hostUserEmailField.changeAndSave(moved)).toBe(200);

    const mail = await inviteEmailTo(moved, since);
    expect(mail.link.payload.email).toBe(moved);
    expect(mailsTo(user.email, since), 'nothing more goes to the old address').toEqual([]);
    expect(Qc913Data.invites(user.userId)).toEqual([
      expect.objectContaining({ uuid: user.mail.link.payload.jti, email: user.email, status: INVITE_ROW_STATUS.cancelled }),
      expect.objectContaining({ uuid: mail.link.payload.jti, email: moved, status: INVITE_ROW_STATUS.sent, replaces: user.mail.link.payload.jti }),
    ]);
    await adminUserFormPage.open(user.userId);
    await adminUserFormPage.signIn.expectStatus('invited');
  });

  async function driverAcceptsThroughVendorPortal(
    browser: Browser,
    person: { email: string; firstName: string; lastName: string },
  ): Promise<{ sub: string; userId: string; mail: InviteEmail }> {
    const vendor = qc913Vendor();
    const truck = Qc913Data.vendorTruck(1);
    const portal = await VendorPortalSession.signIn(browser, vendor);
    let userId: string;
    let mail: InviteEmail;
    try {
      await expect(portal.sidebar.manageUsers).toBeVisible();
      await expect(portal.sidebar.driverInvites, 'the Driver Invites menu is gone').toHaveCount(0);

      await portal.form.open();
      await portal.form.expectNoPasswordFields();
      await portal.form.fillPerson(person.email, person.firstName, person.lastName);
      await portal.form.chooseTruck(truck.name);
      userId = await portal.form.saveNew();
      await portal.form.expectToast(USER_CREATED_MESSAGE);
      await portal.form.signIn.expectStatus('not-invited');

      const since = MailSink.mark();
      expectInviteSent(await portal.form.signIn.sendInvite());
      await portal.form.signIn.expectStatus('invited');
      mail = await inviteEmailTo(person.email, since);
      expect(mail.link.payload.user_type).toBe('driver');

      await portal.list.open('vendor');
      await portal.list.expectBadge(person.email, 'invited');
    } finally {
      await portal.close();
    }

    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.acceptAsNew(mail!.acceptUrl, { ...person, password: newPassword() });
      expect(outcome.status).toBe('recorded');
      await invitee.invite.expectSetupComplete(true);
    } finally {
      await invitee.close();
    }

    const sub = Qc913Data.identityUserUuid(person.email)!;
    expect(Qc913Data.hostUser(person.email)).toMatchObject({ id: userId!, userUuid: sub, emailConfirmed: true });
    return { sub, userId: userId!, mail: mail! };
  }

  test('UINV-09 a Vendor creates a Driver on its truck in My Users (no password fields), invites it, the driver accepts, and DRIVERS links the driver to the host', async ({
    browser,
    playwright,
  }) => {
    test.skip(!canUseDriversDb() || !env.driversApiUrl, 'Needs DRIVERS_API_URL and the DRIVERS local database.');
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const mode = new HostDriversMode(context);
    const original = mode.current();
    await mode.set('On');
    let accepted: { sub: string; userId: string; mail: InviteEmail };
    try {
      accepted = await driverAcceptsThroughVendorPortal(browser, DRIVER);
    } finally {
      if (original && original !== 'On') await mode.set(original);
      await context.dispose();
    }
    const { sub, mail } = accepted;
    const hostUuid = Qc913Data.hostUuid();
    await expect
      .poll(() => Qc913Data.activeDriverLinks(hostUuid, sub), {
        message: 'DRIVERS links the driver to the host',
        timeout: 60_000,
        intervals: [1_000, 2_000, 5_000],
      })
      .toBe(1);
    if (env.hostApiLog) {
      await expect
        .poll(() => Qc913Data.hostLogContains(`Drivers linked invite ${mail!.link.payload.jti}`), {
          message: 'the host log shows LinkEstablished',
          timeout: 60_000,
        })
        .toBe(true);
    } else {
      test.info().annotations.push({ type: 'skipped check', description: 'HOST_API_LOG is not set, so LinkEstablished in the host log was not checked.' });
    }
  });

  test('UINV-16 with Drivers:Mode Off a Driver who accepts an invite is linked on the host only: no DriverInviteAccepted is sent and DRIVERS gets no link', async ({
    browser,
    playwright,
  }) => {
    test.skip(!canUseDriversDb() || !env.driversApiUrl, 'Needs DRIVERS_API_URL and the DRIVERS local database.');
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const mode = new HostDriversMode(context);
    const original = mode.current();
    await mode.set('Off');
    try {
      const { sub, mail } = await driverAcceptsThroughVendorPortal(browser, DRIVER_MODE_OFF);
      const hostUuid = Qc913Data.hostUuid();
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      expect(Qc913Data.activeDriverLinks(hostUuid, sub), 'DRIVERS has no link for a host with Drivers:Mode Off').toBe(0);
      if (env.hostApiLog) {
        expect(Qc913Data.hostLogContains(`DriverInviteAccepted for invite ${mail.link.payload.jti} queued`), 'no DriverInviteAccepted is queued').toBe(false);
      } else {
        test
          .info()
          .annotations.push({ type: 'skipped check', description: 'HOST_API_LOG is not set, so the host log was not checked for DriverInviteAccepted.' });
      }
    } finally {
      await mode.set(original ?? 'Off');
      await context.dispose();
    }
  });

  test('UINV-10 the Manage Users list shows the Sign-in badge of linked, declined and invited users, and the list API carries the same invite status', async ({
    userListSignInColumn,
  }) => {
    test.skip(!created.sub, 'UINV-03 did not link the user.');
    await userListSignInColumn.open('admin');
    await userListSignInColumn.expectBadge(NEW_USER.email, 'linked');
    await userListSignInColumn.expectBadge(qc913Email('declined'), 'declined');
    await userListSignInColumn.expectBadge(qc913Email('moved-to'), 'invited');

    expect(await api.listedInvite('manageusers', NEW_USER.email)).toMatchObject({ status: 'linked', canSend: false });
    expect(await api.listedInvite('manageusers', qc913Email('declined'))).toMatchObject({ status: 'declined', canSend: true });
  });

  test('UINV-12 the removed api/driver-invites is gone, a not-invited user is listed as not-invited, and the return address answers 400 without a redirect to a missing, malformed or wrongly signed invite_result', async () => {
    expect(await api.removedDriverInvites(), 'GET api/driver-invites is gone').toBe(404);
    expect(await api.listedInvite('manageusers', NEW_USER.email), 'UINV-01 user is in the list with its invite').toMatchObject({ status: expect.any(String) });

    const forged = signInviteLink({
      privateJwk: newInviteKeyPair('e2e-qc913-forged').privateJwk,
      issuer: env.identityUrl,
      email: NEW_USER.email,
      returnUrl: `${env.appApiUrl}/api/invites/return`,
      typ: 'qc-invite-result+jwt',
    }).token;
    for (const bad of ['not-a-token', 'eyJhbGciOiJSUzI1NiJ9.eyJpbnZpdGUiOiJ4In0.c2ln', forged]) {
      const answer = await api.inviteReturn(bad);
      expect(answer.status, `invite_result=${bad.slice(0, 20)}...`).toBe(400);
      expect(answer.location).toBeNull();
      expect(answer.text).toContain(INVALID_ANSWER_MESSAGE);
    }
    expect((await api.inviteReturn(null)).status).toBe(400);
  });

  test('UINV-11 the invite endpoint answers 404 for an unknown user and 400 for an inactive one, and sends nothing', async () => {
    const inactive = qc913Email('inactive');
    const createdInactive = await api.createUser({ userName: inactive, firstName: 'Ina', lastName: 'Active', isActive: false });
    expect(createdInactive.status, createdInactive.text).toBe(201);
    const refused = await api.sendInvite('manageusers', createdInactive.data!);
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toContain(INACTIVE_MESSAGE);
    expect((await api.sendInvite('manageusers', crypto.randomUUID())).status).toBe(404);
    expect(Qc913Data.invites(createdInactive.data!)).toEqual([]);
    expect(Qc913Data.notificationCount(inactive, INVITE_EMAIL_TYPE)).toBe(0);
  });

  test('UINV-15 Resend invite on an open invite asks first: Cancel sends nothing and keeps the old link, and Resend invite in the dialog emails a new link and the old one is refused', async ({
    browser,
    request,
    adminUserFormPage,
  }) => {
    const user = await createAndInvite(api, 'confirm-resend', 'Cora');
    const old = user.mail;
    await adminUserFormPage.open(user.userId);
    await adminUserFormPage.signIn.expectStatus('invited');

    const beforeCancel = MailSink.mark();
    await adminUserFormPage.signIn.pressResend();
    expect(await adminUserFormPage.signIn.cancelResend(), 'Cancel sends no invite request').toBe(0);
    await adminUserFormPage.signIn.expectStatus('invited');
    await adminUserFormPage.signIn.expectSendButton('Resend invite');
    expect(Qc913Data.invites(user.userId), 'the open invite is kept').toEqual([
      expect.objectContaining({ uuid: old.link.payload.jti, status: INVITE_ROW_STATUS.sent, replaces: null, responded: false }),
    ]);
    expect(mailsTo(user.email, beforeCancel), 'Cancel emails nothing').toEqual([]);
    expect(await identityAcceptsLink(request, old.link.token), 'the old link still opens on Identity').toBe(true);

    const since = MailSink.mark();
    await adminUserFormPage.signIn.pressResend();
    expectInviteSent(await adminUserFormPage.signIn.confirmResend());
    await adminUserFormPage.signIn.expectToast(INVITE_SENT_MESSAGE);
    await adminUserFormPage.signIn.expectStatus('invited');
    const fresh = await inviteEmailTo(user.email, since);
    expect(fresh.link.payload.jti).not.toBe(old.link.payload.jti);
    expect(Qc913Data.invites(user.userId)).toEqual([
      expect.objectContaining({ uuid: old.link.payload.jti, status: INVITE_ROW_STATUS.cancelled }),
      expect.objectContaining({ uuid: fresh.link.payload.jti, status: INVITE_ROW_STATUS.sent, replaces: old.link.payload.jti }),
    ]);

    const invitee = await InviteeBrowser.open(browser);
    try {
      const refused = await invitee.decline(old.declineUrl);
      expect(refused.status, 'the replaced link is not recorded').toBe('expired');
      await invitee.invite.expectFailed();
    } finally {
      await invitee.close();
    }
    expect(Qc913Data.invites(user.userId).map((row) => row.status)).toEqual([INVITE_ROW_STATUS.cancelled, INVITE_ROW_STATUS.sent]);
  });

  test('UINV-13 in Legacy sign-in mode Manage Users takes a password again: create needs one and the user signs in with it, Edit User shows the password row and no Sign-in section and resets the password, and Send invite is refused', async ({
    adminUserFormPage,
    hostSignInMode,
  }) => {
    const email = qc913Email('legacy');
    const first = newPassword();
    const second = newPassword();
    await inLegacyMode(hostSignInMode, async () => {
      const refused = await api.createUser({ userName: email, firstName: 'Leo', lastName: 'Legacy' });
      expect(refused.status, refused.text).toBe(400);
      expect(refused.text).toContain('Password is required.');
      expect(Qc913Data.hostUser(email), 'no user is created without a password').toBeNull();

      const mismatched = await api.createUser({ userName: email, firstName: 'Leo', lastName: 'Legacy', password: first, confirmPassword: `${first}x` });
      expect(mismatched.status, 'the passwords must match').toBe(400);
      expect(mismatched.text).toContain('Passwords must match.');

      const saved = await api.createUser({ userName: email, firstName: 'Leo', lastName: 'Legacy', password: first });
      expect(saved.status, saved.text).toBe(201);
      const userId = saved.data!;
      expect(Qc913Data.hostUser(email), 'the user is stored with the password').toMatchObject({ id: userId, hasPassword: true, isActive: true });
      expect(await api.passwordLogin(email, first), 'the new user signs in with the password it was given').toBe(200);

      const invite = await api.sendInvite('manageusers', userId);
      expect(invite.status, invite.text).toBe(400);
      expect(invite.text).toContain(PASSWORD_SIGN_IN_MESSAGE);
      expect((await api.editForm('manageusers', userId)).data?.invite).toMatchObject({ canSend: false });
      expect(Qc913Data.invites(userId)).toEqual([]);

      await adminUserFormPage.open();
      await adminUserFormPage.expectPasswordRowAndNoSignIn();
      await expect(adminUserFormPage.createHint).toHaveCount(0);

      await adminUserFormPage.open(userId);
      await adminUserFormPage.expectPasswordRowAndNoSignIn();
      await expect(adminUserFormPage.password).toHaveValue('');
      await adminUserFormPage.fillPassword(second);
      expect(await adminUserFormPage.saveExisting()).toBe(200);
      expect(await api.passwordLogin(email, second), 'the password set on Edit User signs in').toBe(200);
      expect(await api.passwordLogin(email, first), 'the old password no longer signs in').toBe(401);
    });
  });

  test('UINV-14 in Legacy sign-in mode the Vendor Portal takes a password: a driver created in My Users with one signs in with it, its edit page shows the password row and no Sign-in section, and Send invite is refused', async ({
    browser,
    hostSignInMode,
  }) => {
    const vendor = qc913Vendor();
    const truck = Qc913Data.vendorTruck(2);
    const email = qc913Email('legacy-driver');
    const password = newPassword();
    const portal = await VendorPortalSession.signIn(browser, vendor);
    try {
      await inLegacyMode(hostSignInMode, async () => {
        await portal.form.open();
        await portal.form.expectPasswordRowAndNoSignIn();
        await portal.form.fillPerson(email, 'Lena', 'Legacy');
        await portal.form.chooseTruck(truck.name);
        await portal.form.fillPassword(password);
        const userId = await portal.form.saveNew();
        await portal.form.expectToast(LEGACY_USER_CREATED_MESSAGE);
        await portal.form.expectPasswordRowAndNoSignIn();
        expect(Qc913Data.hostUser(email), 'the driver is stored with the password').toMatchObject({ id: userId, hasPassword: true, isActive: true });

        const vendorApi = api.withToken(await portal.accessToken());
        const invite = await vendorApi.sendInvite('vendor', userId);
        expect(invite.status, invite.text).toBe(400);
        expect(invite.text).toContain(PASSWORD_SIGN_IN_MESSAGE);
        expect((await vendorApi.editForm('vendor', userId)).data?.invite).toMatchObject({ canSend: false });
        expect(Qc913Data.invites(userId)).toEqual([]);
        expect(await api.passwordLogin(email, password), 'the driver signs in with the password the vendor gave it').toBe(200);
      });
    } finally {
      await portal.close();
    }
  });
});
