// QC-905 (D63): the login email is locked once the invite is accepted; support changes it in Admin for every system.
// Local only: every person is an e2e.qc905.*@quarryconnect.test throwaway seeded by seed/identity-qc905-user.apply.sql and
// seed/host-qc905-user.apply.sql, and removed with their email change requests and change log rows by
// identity-qc905.remove.sql, host-qc905.remove.sql and master-qc905.remove.sql. Host users whose UserUUID is set stand for
// accepted invites (email locked); host users with no UserUUID stand for invites not yet accepted (email editable).
// Admin > Users runs as a throwaway host admin of organisation 30 (two-step on) and Vendor > Users as a throwaway vendor of
// organisation 34 editing drivers under its truck 38, not the shared app accounts.
import type { APIRequestContext } from '@playwright/test';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, canUseMasterDb } from '@utils/localDb';
import { canReadIdentityLog, markIdentityLog } from '@utils/identityLog';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { IdentityAdminApi } from '@api/identity-admin.api';
import { AdminApi, canUseAdminApi } from '@api/admin.api';
import { decodeJwt } from '@api/password-grant.api';
import { identityAccessToken } from '@api/host-account.api';
import {
  EMAIL_LOCKED_MESSAGE,
  HOST_ORGANISATION_ID,
  VENDOR_ORGANISATION_ID,
  VENDOR_TRUCK_ORGANISATION_ID,
  changeLogSummaries,
  emailChangeLinkSince,
  emailChangeRows,
  hostFieldError,
  hostLoginEmail,
  identityLoginEmail,
  qc905Email,
  remainingQc905Rows,
  removeQc905Users,
  seedQc905HostUser,
  seedQc905IdentityUser,
  type Qc905HostUser,
} from '@api/email-change.api';
import { EmailLockSession, type ConfirmEmailChangePage } from '@pages/email-change.page';
import { HostSignInFlow } from '@pages/host-sign-in-flow.page';

const SERVICE_CLIENT = 'identity.admin.service';
const DAY_MS = 24 * 60 * 60 * 1000;

const needsDatabases = !canSeedLocalDb() || !canUseIdentityDb() || !canUseMasterDb() || !env.admin;
const DATABASES_REASON = "Needs the host's, Identity's and HOST_MASTER's local databases and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users.";

function withUpperCase(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.toUpperCase()}@${domain}`;
}

test.describe('Host user edit locks the login email after the invite is accepted (QC-905)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(needsDatabases, DATABASES_REASON);
  test.skip(!env.appUrl || !env.appApiUrl, 'APP_URL and APP_API_URL (the host app and API) are not set.');

  let admin: ThrowawayUser;
  let vendor: ThrowawayUser;
  let lockedUser: Qc905HostUser;
  let openUser: Qc905HostUser;
  let lockedDriver: Qc905HostUser;
  let openDriver: Qc905HostUser;
  let adminSession: EmailLockSession;

  test.beforeAll(async ({ browser }) => {
    removeQc905Users();
    admin = seedQc905IdentityUser('host-admin');
    seedQc905HostUser({ name: 'host-admin', role: 'Admin', organisationId: HOST_ORGANISATION_ID, accepted: false, identity: admin });
    vendor = seedQc905IdentityUser('vendor');
    seedQc905HostUser({ name: 'vendor', role: 'Vendor', organisationId: VENDOR_ORGANISATION_ID, accepted: false, identity: vendor });
    lockedUser = seedQc905HostUser({ name: 'locked', role: 'Admin', organisationId: HOST_ORGANISATION_ID, accepted: true });
    openUser = seedQc905HostUser({ name: 'open', role: 'Admin', organisationId: HOST_ORGANISATION_ID, accepted: false });
    lockedDriver = seedQc905HostUser({ name: 'locked-driver', role: 'Driver', organisationId: VENDOR_TRUCK_ORGANISATION_ID, accepted: true });
    openDriver = seedQc905HostUser({ name: 'open-driver', role: 'Driver', organisationId: VENDOR_TRUCK_ORGANISATION_ID, accepted: false });

    adminSession = await EmailLockSession.signIn(browser, admin);
  });

  test.afterAll(async () => {
    await adminSession?.close();
    removeQc905Users();
    expect(remainingQc905Rows(), 'no e2e.qc905 users, requests or change log rows are left').toEqual({ host: 0, identity: 0, requests: 0, changeLogs: 0 });
  });

  test('EMLCHG-01 Admin > Users edit of a user who accepted the invite shows the email read-only with "Contact support to change your email." and IsEmailLocked true', async ({
    hostUserEditApi,
  }) => {
    await adminSession.adminUserEdit.open(lockedUser.userId);
    await adminSession.emailField.expectLocked(lockedUser.email);

    await hostUserEditApi.useTokenOf(adminSession.page);
    expect((await hostUserEditApi.edit('manageusers', lockedUser.userId))['IsEmailLocked']).toBe(true);
    expect((await hostUserEditApi.edit('manageusers', openUser.userId))['IsEmailLocked']).toBe(false);
  });

  test('EMLCHG-02 the Manage Users edit API refuses a different email for an accepted user with a 400 on userName, and accepts but ignores a case-only change', async ({
    hostUserEditApi,
  }) => {
    await hostUserEditApi.useTokenOf(adminSession.page);
    const model = await hostUserEditApi.edit('manageusers', lockedUser.userId);

    const refused = await hostUserEditApi.save('manageusers', { ...model, userName: qc905Email('locked-moved') });
    expect(refused.status, refused.text).toBe(400);
    expect(hostFieldError(refused.body, 'userName'), refused.text).toBe(EMAIL_LOCKED_MESSAGE);
    expect(hostLoginEmail(lockedUser.userId)).toEqual({ email: lockedUser.email, userName: lockedUser.email });

    const caseOnly = await hostUserEditApi.save('manageusers', { ...model, userName: withUpperCase(lockedUser.email) });
    expect(caseOnly.status, caseOnly.text).toBe(200);
    expect(hostLoginEmail(lockedUser.userId)).toEqual({ email: lockedUser.email, userName: lockedUser.email });
  });

  test('EMLCHG-03 Admin > Users edit of a user who has not accepted an invite keeps the email editable and saves the new one as Email and UserName', async () => {
    const field = adminSession.emailField;
    await adminSession.adminUserEdit.open(openUser.userId);
    await field.expectEditable(openUser.email);

    const moved = qc905Email('open-moved');
    expect(await field.changeAndSave(moved)).toBe(200);
    await field.expectSaved();
    expect(hostLoginEmail(openUser.userId)).toEqual({ email: moved, userName: moved });

    await adminSession.adminUserEdit.open(openUser.userId);
    await field.expectEditable(moved);
  });

  test('EMLCHG-04 My Profile shows "Contact support to change your email." under the signed-in user\'s email', async () => {
    await adminSession.myProfile.open();
    await adminSession.myProfile.expectEmailNote(admin.email);
    expect(hostLoginEmail(admin.userId)).toEqual({ email: admin.email, userName: admin.email });
  });

  test('EMLCHG-05 Vendor > Users edit of a driver who accepted the invite shows the email read-only and the API refuses a different email with a 400 on userName', async ({
    browser,
    hostUserEditApi,
  }) => {
    const session = await EmailLockSession.signIn(browser, vendor);
    try {
      await session.vendorUserEdit.open(lockedDriver.userId);
      await session.emailField.expectLocked(lockedDriver.email);

      await hostUserEditApi.useTokenOf(session.page);
      const model = await hostUserEditApi.edit('vendor', lockedDriver.userId);
      expect(model['IsEmailLocked']).toBe(true);
      expect((await hostUserEditApi.edit('vendor', openDriver.userId))['IsEmailLocked']).toBe(false);

      const refused = await hostUserEditApi.save('vendor', { ...model, userName: qc905Email('locked-driver-moved') });
      expect(refused.status, refused.text).toBe(400);
      expect(hostFieldError(refused.body, 'userName'), refused.text).toBe(EMAIL_LOCKED_MESSAGE);
      expect(hostLoginEmail(lockedDriver.userId)).toEqual({ email: lockedDriver.email, userName: lockedDriver.email });
    } finally {
      await session.close();
    }
  });

  test('EMLCHG-06 Vendor > Users edit of a driver who has not accepted an invite saves the new email as both Email and UserName', async ({ browser }) => {
    const session = await EmailLockSession.signIn(browser, vendor);
    try {
      await session.vendorUserEdit.open(openDriver.userId);
      await session.emailField.expectEditable(openDriver.email);

      const moved = qc905Email('open-driver-moved');
      expect(await session.emailField.changeAndSave(moved)).toBe(200);
      await session.emailField.expectSaved();
      expect(hostLoginEmail(openDriver.userId)).toEqual({ email: moved, userName: moved });
    } finally {
      await session.close();
    }
  });
});

test.describe('Identity changes a login email only after the new address confirms it (QC-905)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.use(signedOut);
  test.skip(needsDatabases, DATABASES_REASON);
  test.skip(!env.adminApiClient, "Needs Identity's administration service client (ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET).");
  test.skip(!canReadIdentityLog(), "Needs Identity's log folder (IDENTITY_LOG_DIR), where Development logs the confirmation link.");
  test.skip(!env.hostClient, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI) to sign in with the old and new email.');

  let person: ThrowawayUser;
  let holder: ThrowawayUser;
  let racer: ThrowawayUser;
  let confirmedLink = '';

  test.beforeAll(() => {
    removeQc905Users();
    person = seedQc905IdentityUser('person', false);
    holder = seedQc905IdentityUser('holder', false);
    racer = seedQc905IdentityUser('racer', false);
  });

  test.afterAll(() => {
    removeQc905Users();
    expect(remainingQc905Rows(), 'no e2e.qc905 users, requests or change log rows are left').toEqual({ host: 0, identity: 0, requests: 0, changeLogs: 0 });
  });

  test('EMLCHG-07 the email change request answers 400 on NewEmail for a missing, malformed or unchanged email, 400 on SupportReference for a missing or too long one, 404 for an unknown user, and records nothing', async ({
    request,
  }) => {
    const api = await IdentityAdminApi.signIn(request);
    const path = `/users/${person.userId}/email-change`;
    const cases: { body: Record<string, unknown>; field: 'NewEmail' | 'SupportReference' }[] = [
      { body: { NewEmail: '', SupportReference: 'QC-905' }, field: 'NewEmail' },
      { body: { NewEmail: 'not-an-email', SupportReference: 'QC-905' }, field: 'NewEmail' },
      { body: { NewEmail: withUpperCase(person.email), SupportReference: 'QC-905' }, field: 'NewEmail' },
      { body: { NewEmail: qc905Email('person-new'), SupportReference: '  ' }, field: 'SupportReference' },
      { body: { NewEmail: qc905Email('person-new'), SupportReference: 'x'.repeat(101) }, field: 'SupportReference' },
    ];
    for (const { body, field } of cases) {
      const result = await api.post(path, body);
      expect(result.status, `${JSON.stringify(body)} -> ${result.text}`).toBe(400);
      expect(Object.keys(result.body?.errors ?? {}), result.text).toContain(field);
    }

    expect((await api.post(`/users/e2e-qc905-no-such-user/email-change`, { NewEmail: qc905Email('person-new'), SupportReference: 'QC-905' })).status).toBe(404);
    expect(emailChangeRows(person.userId)).toEqual([]);
    expect(identityLoginEmail(person.userId)).toMatchObject({ email: person.email, userName: person.email });
  });

  test('EMLCHG-08 the email change request answers 409 on NewEmail when another login already has the email, in any case, and records nothing', async ({
    request,
  }) => {
    const api = await IdentityAdminApi.signIn(request);
    const result = await api.post(`/users/${person.userId}/email-change`, { NewEmail: withUpperCase(holder.email), SupportReference: 'QC-905' });
    expect(result.status, result.text).toBe(409);
    expect(result.body?.errors?.NewEmail, result.text).toEqual(['Another login already uses that email.']);
    expect(emailChangeRows(person.userId)).toEqual([]);
  });

  test('EMLCHG-09 a request answers the pending email, shows it on the user, records the audit row, mails a 24 hour link to the new address, and a cancel clears it and kills the link', async ({
    request,
    confirmEmailChangePage,
  }) => {
    const api = await IdentityAdminApi.signIn(request);
    const newEmail = qc905Email('person-cancel');
    const mark = markIdentityLog();
    const before = Date.now();

    const requested = await api.post(`/users/${person.userId}/email-change`, {
      NewEmail: ` ${newEmail} `,
      RequestedBy: 'e2e.qc905.support',
      SupportReference: ' QC-905-A ',
    });
    expect(requested.status, requested.text).toBe(200);
    expect(requested.body).toMatchObject({ UserId: person.userId, Email: person.email, PendingEmail: newEmail });
    const expires = Date.parse(requested.body.PendingEmailExpires);
    expect(expires).toBeGreaterThan(before + DAY_MS - 120_000);
    expect(expires).toBeLessThan(Date.now() + DAY_MS + 120_000);

    const detail = await api.get(`/users/${person.userId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ PendingEmail: newEmail });
    expect(Date.parse(detail.body.PendingEmailExpires)).toBe(expires);

    expect(emailChangeRows(person.userId)).toEqual([
      {
        userUuid: person.userId,
        oldEmail: person.email,
        newEmail,
        requestedBy: 'e2e.qc905.support',
        supportReference: 'QC-905-A',
        confirmed: false,
        canceled: false,
        lifetimeHours: 24,
      },
    ]);
    expect(identityLoginEmail(person.userId)).toMatchObject({ email: person.email, userName: person.email });

    let link: string | null = null;
    await expect
      .poll(() => (link = emailChangeLinkSince(mark, newEmail)), { message: 'Identity logs the confirmation link for the new address' })
      .not.toBeNull();

    const canceled = await api.delete(`/users/${person.userId}/email-change`);
    expect(canceled.status, canceled.text).toBe(200);
    expect(canceled.body).toMatchObject({ UserId: person.userId, Email: person.email, PendingEmail: null, PendingEmailExpires: null });
    expect((await api.get(`/users/${person.userId}`)).body).toMatchObject({ PendingEmail: null, PendingEmailExpires: null });
    expect(emailChangeRows(person.userId)).toEqual([expect.objectContaining({ newEmail, confirmed: false, canceled: true })]);

    await confirmEmailChangePage.open(link!);
    await confirmEmailChangePage.expectInvalid();
    expect(identityLoginEmail(person.userId)).toMatchObject({ email: person.email });
  });

  test('EMLCHG-10 a new request replaces the open one; opening its link changes nothing, confirming it changes Email and UserName, rotates the security stamp and uses the link up', async ({
    request,
    confirmEmailChangePage,
  }) => {
    const api = await IdentityAdminApi.signIn(request);
    const firstEmail = qc905Email('person-first');
    const newEmail = qc905Email('person-new');

    const firstMark = markIdentityLog();
    expect((await api.post(`/users/${person.userId}/email-change`, { NewEmail: firstEmail, SupportReference: 'QC-905-B' })).status).toBe(200);
    let firstLink: string | null = null;
    await expect.poll(() => (firstLink = emailChangeLinkSince(firstMark, firstEmail))).not.toBeNull();

    const mark = markIdentityLog();
    const second = await api.post(`/users/${person.userId}/email-change`, { NewEmail: newEmail, SupportReference: 'QC-905-C' });
    expect(second.status, second.text).toBe(200);
    expect(emailChangeRows(person.userId).filter((row) => !row.canceled)).toEqual([expect.objectContaining({ newEmail, requestedBy: SERVICE_CLIENT })]);
    let link: string | null = null;
    await expect.poll(() => (link = emailChangeLinkSince(mark, newEmail))).not.toBeNull();
    confirmedLink = link!;

    await confirmEmailChangePage.open(firstLink!);
    await confirmEmailChangePage.expectInvalid();

    const stamp = identityLoginEmail(person.userId).securityStamp;
    await confirmEmailChangePage.open(link!);
    await confirmEmailChangePage.expectQuestion(newEmail);
    await confirmEmailChangePage.open(link!);
    await confirmEmailChangePage.expectQuestion(newEmail);
    expect(identityLoginEmail(person.userId)).toEqual({ email: person.email, userName: person.email, securityStamp: stamp });

    await confirmEmailChangePage.confirm();
    await confirmEmailChangePage.expectDone(newEmail);
    const after = identityLoginEmail(person.userId);
    expect(after).toMatchObject({ email: newEmail, userName: newEmail });
    expect(after.securityStamp).not.toBe(stamp);
    expect(emailChangeRows(person.userId).find((row) => row.newEmail === newEmail)).toMatchObject({ confirmed: true, canceled: false });
    expect((await api.get(`/users/${person.userId}`)).body).toMatchObject({ email: newEmail, PendingEmail: null });

    await confirmEmailChangePage.open(link!);
    await confirmEmailChangePage.expectInvalid();
  });

  test('EMLCHG-11 after the change the old email no longer signs in and the new one does', async ({ page, identityLoginPage }) => {
    test.skip(!confirmedLink, 'EMLCHG-10 did not confirm a change.');
    const oldFlow = new HostSignInFlow(page, env.hostClient!);
    await oldFlow.open();
    await identityLoginPage.signIn({ email: person.email, password: person.password });
    await expect(identityLoginPage.error).toBeVisible();
    await identityLoginPage.expectVisible();

    const newFlow = new HostSignInFlow(page, env.hostClient!);
    await newFlow.open();
    await identityLoginPage.signIn({ email: qc905Email('person-new'), password: person.password });
    await newFlow.expectCallback();
  });

  test('EMLCHG-12 confirming answers "already used by another login" and changes nothing when another login took the email after the request', async ({
    request,
    confirmEmailChangePage,
  }) => {
    const api = await IdentityAdminApi.signIn(request);
    const contested = qc905Email('contested');
    const mark = markIdentityLog();
    expect((await api.post(`/users/${racer.userId}/email-change`, { NewEmail: contested, SupportReference: 'QC-905-D' })).status).toBe(200);
    let link: string | null = null;
    await expect.poll(() => (link = emailChangeLinkSince(mark, contested))).not.toBeNull();

    seedQc905IdentityUser('contested', false);

    await confirmEmailChangePage.open(link!);
    await confirmEmailChangePage.expectQuestion(contested);
    await confirmEmailChangePage.confirm();
    await confirmEmailChangePage.expectTaken();
    expect(identityLoginEmail(racer.userId)).toMatchObject({ email: racer.email, userName: racer.email });
    expect(emailChangeRows(racer.userId)).toEqual([expect.objectContaining({ newEmail: contested, confirmed: false })]);
  });
});

test.describe('Host sign-in takes the email Identity confirmed (QC-905)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.use(signedOut);
  test.skip(needsDatabases, DATABASES_REASON);
  test.skip(!env.appApiUrl || !env.hostClient, 'Needs the host API (APP_API_URL) and the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI).');
  test.skip(!env.adminApiClient || !canReadIdentityLog(), "Needs Identity's administration service client and its log folder (IDENTITY_LOG_DIR).");

  test.beforeAll(() => {
    removeQc905Users();
  });

  test.afterAll(() => {
    removeQc905Users();
    expect(remainingQc905Rows(), 'no e2e.qc905 users, requests or change log rows are left').toEqual({ host: 0, identity: 0, requests: 0, changeLogs: 0 });
  });

  async function changeEmail(request: APIRequestContext, confirmPage: ConfirmEmailChangePage, user: ThrowawayUser, newEmail: string): Promise<void> {
    const api = await IdentityAdminApi.signIn(request);
    const mark = markIdentityLog();
    const requested = await api.post(`/users/${user.userId}/email-change`, { NewEmail: newEmail, SupportReference: 'QC-905-SYNC' });
    expect(requested.status, requested.text).toBe(200);
    let link: string | null = null;
    await expect.poll(() => (link = emailChangeLinkSince(mark, newEmail))).not.toBeNull();
    await confirmPage.open(link!);
    await confirmPage.confirm();
    await confirmPage.expectDone(newEmail);
    expect(identityLoginEmail(user.userId)).toMatchObject({ email: newEmail });
  }

  test('EMLCHG-13 after a confirmed change the next host sign-in carries the new email in the token and sets the host user Email and UserName to it', async ({
    browser,
    request,
    hostAccountApi,
    confirmEmailChangePage,
  }) => {
    const user = seedQc905IdentityUser('sync', false);
    const host = seedQc905HostUser({ name: 'sync', role: 'Driver', organisationId: HOST_ORGANISATION_ID, accepted: false, identity: user });
    const newEmail = qc905Email('sync-new');

    const first = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const token = await identityAccessToken(await first.newPage(), request, user);
      expect(decodeJwt(token).claims['email']).toBe(user.email);
      expect((await hostAccountApi.identityExchange(token)).status).toBe(200);
      expect(hostLoginEmail(host.userId)).toEqual({ email: user.email, userName: user.email });

      await changeEmail(request, confirmEmailChangePage, user, newEmail);
    } finally {
      await first.close();
    }

    const second = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const token = await identityAccessToken(await second.newPage(), request, { email: newEmail, password: user.password });
      expect(decodeJwt(token).claims['email']).toBe(newEmail);
      const exchange = await hostAccountApi.identityExchange(token);
      expect(exchange.status, JSON.stringify(exchange.body)).toBe(200);
      expect(hostLoginEmail(host.userId)).toEqual({ email: newEmail, userName: newEmail });
    } finally {
      await second.close();
    }
  });

  test('EMLCHG-14 a host sign-in keeps the host user email when another host user already has the new one', async ({
    browser,
    request,
    hostAccountApi,
    confirmEmailChangePage,
  }) => {
    const user = seedQc905IdentityUser('sync-kept', false);
    const host = seedQc905HostUser({ name: 'sync-kept', role: 'Driver', organisationId: HOST_ORGANISATION_ID, accepted: false, identity: user });
    const other = seedQc905HostUser({ name: 'sync-other', role: 'Driver', organisationId: HOST_ORGANISATION_ID, accepted: false });

    const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      expect((await hostAccountApi.identityExchange(await identityAccessToken(await context.newPage(), request, user))).status).toBe(200);
      await changeEmail(request, confirmEmailChangePage, user, other.email);
    } finally {
      await context.close();
    }

    const again = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const token = await identityAccessToken(await again.newPage(), request, { email: other.email, password: user.password });
      expect(decodeJwt(token).claims['email']).toBe(other.email);
      const exchange = await hostAccountApi.identityExchange(token);
      expect(exchange.status, JSON.stringify(exchange.body)).toBe(200);
      expect(hostLoginEmail(host.userId)).toEqual({ email: user.email, userName: user.email });
      expect(hostLoginEmail(other.userId)).toEqual({ email: other.email, userName: other.email });
    } finally {
      await again.close();
    }
  });
});

test.describe('Admin user detail requests and cancels a login email change (QC-905)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(needsDatabases, DATABASES_REASON);
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');

  let target: ThrowawayUser;
  let holder: ThrowawayUser;

  test.beforeAll(() => {
    removeQc905Users();
    target = seedQc905IdentityUser('admin-target', false);
    holder = seedQc905IdentityUser('admin-holder', false);
  });

  test.afterAll(() => {
    removeQc905Users();
    expect(remainingQc905Rows(), 'no e2e.qc905 users, requests or change log rows are left').toEqual({ host: 0, identity: 0, requests: 0, changeLogs: 0 });
  });

  test('EMLCHG-15 the change email dialog shows a field error for a malformed email without calling the API, and the server field error for an email another login has', async ({
    userEmailChangePanel,
    page,
    request,
  }) => {
    const panel = userEmailChangePanel;
    await panel.open(target.userId);
    await expect(panel.email).toContainText(target.email);
    await panel.expectNoPending();
    await panel.openDialog(target.email);

    let posted = 0;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/users\/[^/]+\/email$/i.test(new URL(r.url()).pathname)) posted++;
    });
    await panel.fill('not-an-email', 'QC-905-UI');
    await panel.submit.click();
    await expect(panel.fieldError('change-email-new')).toHaveText('Enter a valid email address.');
    expect(posted).toBe(0);

    await panel.fill(holder.email, 'QC-905-UI');
    expect(await panel.send()).toBe(400);
    await expect(panel.fieldError('change-email-new')).toHaveText('Another login already uses that email.');
    await expect(panel.dialog).toBeVisible();

    const api = AdminApi.asAdmin(request);
    const missingReference = await api.post(`/users/${target.userId}/email`, { NewEmail: qc905Email('admin-target-new'), SupportReference: '' });
    expect(missingReference.status, missingReference.text).toBe(400);
    expect(missingReference.body.errors, missingReference.text).toEqual({ supportReference: ['Enter the support reference.'] });

    await panel.cancel.click();
    await expect(panel.dialog).toHaveCount(0);
    expect(emailChangeRows(target.userId)).toEqual([]);
    expect(changeLogSummaries(`%${target.email}%`)).toEqual([]);
  });

  test('EMLCHG-16 sending a valid change shows the success message and the pending email, writes the change log, and Identity keeps the old email until it is confirmed', async ({
    userEmailChangePanel,
    shell,
    request,
  }) => {
    const panel = userEmailChangePanel;
    const newEmail = qc905Email('admin-target-new');
    await panel.open(target.userId);
    await panel.openDialog(target.email);
    await panel.fill(newEmail, 'QC-905-UI');
    expect(await panel.send()).toBe(200);
    await expect(panel.dialog).toHaveCount(0);
    await shell.expectStatus(`Confirmation sent to ${newEmail}. ${target.email} stays the login until it is confirmed.`);
    await panel.expectPending(newEmail);

    expect(changeLogSummaries(`%${target.email}%`)).toEqual([
      `Requested a login email change from ${target.email} to ${newEmail} (support reference QC-905-UI)`,
    ]);
    const rows = emailChangeRows(target.userId);
    expect(rows).toEqual([expect.objectContaining({ oldEmail: target.email, newEmail, supportReference: 'QC-905-UI', confirmed: false, canceled: false })]);
    expect(rows[0].requestedBy).not.toBe(SERVICE_CLIENT);
    expect(identityLoginEmail(target.userId)).toMatchObject({ email: target.email, userName: target.email });

    const detail = await AdminApi.asAdmin(request).get(`/users/${target.userId}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ PendingEmail: newEmail });
    expect(detail.body.PendingEmailExpires).toBeTruthy();
  });

  test('EMLCHG-17 cancelling the request asks first, clears the pending email in Admin and Identity, and writes the change log', async ({
    userEmailChangePanel,
    shell,
  }) => {
    const panel = userEmailChangePanel;
    const newEmail = qc905Email('admin-target-new');
    await panel.open(target.userId);
    await panel.expectPending(newEmail);
    await panel.cancelRequest(newEmail, target.email);
    await shell.expectStatus('The email change was canceled.');
    await panel.expectNoPending();

    expect(emailChangeRows(target.userId)).toEqual([expect.objectContaining({ newEmail, confirmed: false, canceled: true })]);
    expect(changeLogSummaries(`Canceled the login email change for ${target.email}`)).toHaveLength(1);
    expect(identityLoginEmail(target.userId)).toMatchObject({ email: target.email });
  });
});
