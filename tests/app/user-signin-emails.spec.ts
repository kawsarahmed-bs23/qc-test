// QC-1008: Send Password Reset and the Sign-in emails log on Edit User (Manage Users) and the Vendor Portal user page. The host API
// asks Identity for both (Host-only api/host/users/{userUuid}/password-reset and /email-log, a 60 s ES256 token signed with the host's
// invite key). Local only: runs against the host API (APP_API_URL), the host database (LOCAL_SQL_DATABASE with app.UserInvites), an
// Identity with the QC-1008 migration (auth.AccountEmailRefusals, SendStatus on the reset and magic-link tables, IDENTITY_SQL_DATABASE)
// and HOST_MASTER (MASTER_SQL_DATABASE, the host's invite signing key registered for host.local).
// Local Identity has no mail server, so every send is recorded as failed with email-off; these cases check the failure and refusal paths
// only (a delivered email needs a mail server and is not covered here).
// The Host user who presses the button is the shared host app admin (APP_STATE; read only, a Host Admin needs two-step, which a throwaway
// login cannot do now) and, for USEM-09, a throwaway Vendor (QC-913 helpers). Every user the cases make is an
// e2e.qc913.usem-*@example.com host user, linked by seed/host-qc1008.apply.sql to its own Identity login; the Identity history seed is
// seed/identity-qc1008.apply.sql. Everything is removed before and after by seed/identity-qc1008.remove.sql, seed/host-qc1008.remove.sql
// and removeQc913Data(). The shared accounts are never changed.
// The in-memory Forgot Password limit (3 per address, 20 per IP per hour) resets only when Identity restarts; USEM-04 uses a new address every run.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, queryIdentityDb } from '@utils/localDb';
import { formatAppDateTime } from '@pages/app.page';
import { SignedOutEmailRequests } from '@pages/user-signin-emails.page';
import { VendorPortalSession } from '@pages/user-invites.page';
import { HostUserInvitesApi, Qc913Data, removeQc913Data, seedQc913Login, seedQc913Vendor, type UserArea } from '@api/user-invites.api';
import { EMAIL_OFF_RESET_SENT, QC1008_CLIENT, Qc1008Data, RESET_TOO_SOON, usemEmail } from '@api/user-signin-emails.api';

const ACTIVE = { email: usemEmail('active'), firstName: 'Una', lastName: 'Active' };
const UNLINKED = { email: usemEmail('unlinked'), firstName: 'Ulf', lastName: 'Unlinked' };
const PUBLIC = { email: usemEmail(`public-${Date.now().toString(36)}`), firstName: 'Pia', lastName: 'Public' };
const MAGIC = { email: usemEmail('magic'), firstName: 'Max', lastName: 'Magic' };
const HISTORY = { email: usemEmail('history'), firstName: 'Hana', lastName: 'History' };
const VENDOR_USER = { email: usemEmail('vendor-user'), firstName: 'Vera', lastName: 'Vendor' };

const failedReset = (email: string, by: string) => `Password reset to ${email} was not sent: email is turned off, ${by}`;
const failedLink = (email: string) => `Sign-in link to ${email} was not sent: email is turned off, requested by the user`;

function loginNameOf(email: string): string {
  return email.replace(/^e2e.qc913./, '').replace(/@example.com$/, '');
}

function removeAll(): void {
  if (Qc913Data.hostHasTable('app.UserInvites')) Qc1008Data.removeHost();
  Qc1008Data.removeIdentity();
  removeQc913Data();
}

async function createLinked(api: HostUserInvitesApi, person: { email: string; firstName: string; lastName: string }, invite?: { hoursAgo: number; sentBy: string }): Promise<string> {
  seedQc913Login(person.email.replace(/^e2e\.qc913\./, '').replace(/@example\.com$/, ''), false);
  const created = await api.createUser({ userName: person.email, firstName: person.firstName, lastName: person.lastName, organisationId: Qc1008Data.hostOrganisationId() });
  expect(created.status, `user-create ${person.email}: ${created.text}`).toBe(201);
  Qc1008Data.seedHostUser(person.email, true, invite);
  await expect.poll(() => api.userEditStatus(created.data!), { message: `${person.email} is readable by the Admin`, timeout: 30_000 }).toBe(200);
  return created.data!;
}

test.describe('Send Password Reset and the Sign-in emails log (QC-1008)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb() || !canUseIdentityDb(), "Needs the host's and Identity's local databases (local only).");
  test.skip(!env.appApiUrl || !env.appUrl || !env.appTimeZone, 'APP_URL, APP_API_URL and APP_TIME_ZONE are needed.');
  test.skip(!env.admin || !env.appAdmin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD (the throwaway logins copy that password) and APP_ADMIN_EMAIL for the host session.');
  test.skip(
    canSeedLocalDb() && !Qc913Data.hostHasTable('app.UserInvites'),
    'The host database has no app.UserInvites (QC-913 migration 202611111200).',
  );
  test.skip(
    canUseIdentityDb() && queryIdentityDb(`SELECT CASE WHEN OBJECT_ID(N'auth.AccountEmailRefusals', N'U') IS NULL THEN 0 ELSE 1 END`) !== '1',
    "Identity's database has no auth.AccountEmailRefusals (migration AddAccountEmailLog).",
  );

  let api: HostUserInvitesApi;
  let adminId = '';
  let adminName = '';
  const ids: Record<string, string> = {};

  test.beforeAll(() => {
    removeAll();
    adminId = Qc1008Data.hostUserIdByEmail(env.appAdmin!.email);
    adminName = Qc1008Data.hostUserName(adminId);
  });

  test.beforeEach(({ hostUserInvitesApi }) => {
    api = hostUserInvitesApi.useSession();
  });

  test.afterAll(() => {
    const identity = Qc1008Data.removeIdentity();
    const host = Qc1008Data.removeHost();
    const removed = removeQc913Data();
    expect(identity).toMatch(/left=0/);
    expect(host).toMatch(/left=0/);
    expect(removed.host).toMatch(/left=0;leftInvites=0;leftNotifications=0;leftOrganisations=0/);
    expect(removed.identity).toMatch(/left=0/);
  });

  test('USEM-01 Edit User shows Send Password Reset for a linked, active user and the invite button, no reset button, for a user who is not linked', async ({
    adminUserFormPage,
  }) => {
    ids.active = await createLinked(api, ACTIVE);
    const unlinked = await api.createUser({ userName: UNLINKED.email, firstName: UNLINKED.firstName, lastName: UNLINKED.lastName, organisationId: Qc1008Data.hostOrganisationId() });
    expect(unlinked.status, unlinked.text).toBe(201);
    ids.unlinked = unlinked.data!;
    await expect.poll(() => api.userEditStatus(ids.unlinked), { timeout: 30_000 }).toBe(200);

    await adminUserFormPage.open(ids.active);
    await adminUserFormPage.emails.expectSendButton();
    await expect(adminUserFormPage.emails.log).toBeVisible();
    await expect(adminUserFormPage.emails.identityUnavailable).toHaveCount(0);
    await adminUserFormPage.emails.expectEmpty();
    expect((await api.editForm('manageusers', ids.active)).data?.invite).toMatchObject({ status: 'linked', canSendPasswordReset: true });

    await adminUserFormPage.open(ids.unlinked);
    await adminUserFormPage.signIn.expectSendButton('Send invite');
    await adminUserFormPage.emails.expectNoSendButton();
    await adminUserFormPage.emails.expectEmpty();
    expect((await api.editForm('manageusers', ids.unlinked)).data?.invite).toMatchObject({ canSendPasswordReset: false });
  });

  test('USEM-02 pressing Send Password Reset with Identity email off shows the email-off message inline and in an error toast, adds a failed line first in the log, and stores one failed reset row for the acting Host user', async ({
    adminUserFormPage,
  }) => {
    test.skip(!ids.active, 'USEM-01 did not create the user.');
    const emails = adminUserFormPage.emails;
    await adminUserFormPage.open(ids.active);
    await emails.expectSendButton();

    expect(await emails.pressSend()).toBe(400);
    await emails.expectResult(false, EMAIL_OFF_RESET_SENT(ACTIVE.email));
    await expect(emails.errorToast.filter({ hasText: EMAIL_OFF_RESET_SENT(ACTIVE.email) })).toBeVisible();
    await emails.expectLines([failedReset(ACTIVE.email, `by ${adminName}`)]);
    await emails.expectKinds(['password-reset/failed']);
    await expect(emails.send).toBeEnabled();

    const rows = Qc1008Data.resetLinks(ACTIVE.email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ clientId: QC1008_CLIENT, sendStatus: 2, sendFailure: 'email-off', requestedBy: adminId });
    expect(Qc1008Data.refusals(ACTIVE.email)).toEqual([]);
  });

  test('USEM-03 pressing it again within a minute is refused with the "less than a minute ago" message, adds a refused line above the failed one and stores a refusal row, not another reset', async ({
    adminUserFormPage,
  }) => {
    test.skip(!ids.active, 'USEM-01 did not create the user.');
    const emails = adminUserFormPage.emails;
    await adminUserFormPage.open(ids.active);
    await emails.expectLines([failedReset(ACTIVE.email, `by ${adminName}`)]);

    expect(await emails.pressSend()).toBe(400);
    await emails.expectResult(false, RESET_TOO_SOON);
    await expect(emails.errorToast.filter({ hasText: RESET_TOO_SOON })).toBeVisible();
    await emails.expectLines([`Password reset requested by ${adminName}, not sent: too many requests`, failedReset(ACTIVE.email, `by ${adminName}`)]);
    await emails.expectKinds(['password-reset/refused', 'password-reset/failed']);

    expect(Qc1008Data.resetLinks(ACTIVE.email), 'no second reset row').toHaveLength(1);
    const refusals = Qc1008Data.refusals(ACTIVE.email);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ clientId: QC1008_CLIENT, kind: 'password-reset', reason: 'too-many-requests', requestedBy: adminId });
  });

  test('USEM-04 five public Forgot Password requests from the host sign-in page show three failed lines and two "too many requests" lines requested by the user', async ({
    browser,
    adminUserFormPage,
  }) => {
    ids.public = await createLinked(api, PUBLIC);
    const person = await SignedOutEmailRequests.open(browser);
    try {
      await person.openForgotPassword();
      for (let i = 0; i < 5; i++) await person.requestReset(PUBLIC.email);
    } finally {
      await person.close();
    }
    await expect
      .poll(async () => (await api.emailLog('manageusers', ids.public)).data?.items.length, { message: 'the five requests reach the log', timeout: 60_000 })
      .toBe(5);

    await adminUserFormPage.open(ids.public);
    await adminUserFormPage.emails.expectLines([
      'Password reset requested, not sent: too many requests',
      'Password reset requested, not sent: too many requests',
      failedReset(PUBLIC.email, 'requested by the user'),
      failedReset(PUBLIC.email, 'requested by the user'),
      failedReset(PUBLIC.email, 'requested by the user'),
    ]);
    await adminUserFormPage.emails.expectKinds([
      'password-reset/refused',
      'password-reset/refused',
      'password-reset/failed',
      'password-reset/failed',
      'password-reset/failed',
    ]);
    const rows = Qc1008Data.resetLinks(PUBLIC.email);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ clientId: QC1008_CLIENT, sendStatus: 2, sendFailure: 'email-off', requestedBy: null });
    const refusals = Qc1008Data.refusals(PUBLIC.email);
    expect(refusals).toHaveLength(2);
    for (const refusal of refusals) expect(refusal).toMatchObject({ clientId: QC1008_CLIENT, kind: 'password-reset', reason: 'too-many-requests', requestedBy: null });
  });

  test('USEM-05 four "Email me a sign-in link" requests show three failed sign-in link lines and one "too many requests" line', async ({ browser, adminUserFormPage }) => {
    ids.magic = await createLinked(api, MAGIC);
    const person = await SignedOutEmailRequests.open(browser);
    try {
      await person.openMagicLink();
      for (let i = 0; i < 4; i++) await person.requestSignInLink(MAGIC.email);
    } finally {
      await person.close();
    }
    await expect
      .poll(async () => (await api.emailLog('manageusers', ids.magic)).data?.items.length, { message: 'the four requests reach the log', timeout: 60_000 })
      .toBe(4);

    await adminUserFormPage.open(ids.magic);
    await adminUserFormPage.emails.expectLines([
      'Sign-in link requested, not sent: too many requests',
      failedLink(MAGIC.email),
      failedLink(MAGIC.email),
      failedLink(MAGIC.email),
    ]);
    await adminUserFormPage.emails.expectKinds(['sign-in-link/refused', 'sign-in-link/failed', 'sign-in-link/failed', 'sign-in-link/failed']);
    const rows = Qc1008Data.magicLinks(MAGIC.email);
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ clientId: QC1008_CLIENT, sendStatus: 2, sendFailure: 'email-off' });
    expect(Qc1008Data.refusals(MAGIC.email)).toEqual([expect.objectContaining({ kind: 'sign-in-link', reason: 'too-many-requests', clientId: QC1008_CLIENT })]);
  });

  test.describe('with a seeded history', () => {
    test.beforeAll(async ({ playwright }) => {
      seedQc913Login(loginNameOf(HISTORY.email), false);
      const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        const history = new HostUserInvitesApi(context).useSession();
        const made = await history.createUser({ userName: HISTORY.email, firstName: HISTORY.firstName, lastName: HISTORY.lastName, organisationId: Qc1008Data.hostOrganisationId() });
        expect(made.status, made.text).toBe(201);
        ids.history = made.data!;
        await expect.poll(() => history.userEditStatus(ids.history), { timeout: 30_000 }).toBe(200);
      } finally {
        await context.dispose();
      }
      Qc1008Data.seedHostUser(HISTORY.email, true, { hoursAgo: 72, sentBy: adminId });
      Qc1008Data.seedIdentityHistory(HISTORY.email, adminId);
    });

    const expectedLines = () => [
      `Password reset requested by ${adminName}, not sent: login deactivated`,
      `Sign-in link to ${HISTORY.email} was not sent: mail server refused, requested by the user`,
      `Password reset sent to ${HISTORY.email}, by ${adminName}`,
      `Invite sent to ${HISTORY.email}, by ${adminName}`,
    ];

    test('USEM-06 the log lists the invite sent by a Host user with "Invite sent to <email>, by <name>" next to the Identity lines, with the right kind and outcome', async ({
      adminUserFormPage,
    }) => {
      await adminUserFormPage.open(ids.history);
      await adminUserFormPage.emails.expectLines(expectedLines());
      await adminUserFormPage.emails.expectKinds(['password-reset/refused', 'sign-in-link/failed', 'password-reset/sent', 'invite/sent']);
      await expect(adminUserFormPage.emails.identityUnavailable).toHaveCount(0);
    });

    test('USEM-07 rows saved for another host client, or for no client, never reach this Host log, on the page or in the API', async ({ adminUserFormPage }) => {
      const other = Qc1008Data.resetLinks(HISTORY.email).filter((r) => r.clientId !== QC1008_CLIENT);
      expect(other.map((r) => r.clientId ?? 'none').sort(), 'the seed holds a reset row at another client and one with no client').toEqual(['host.qc660test', 'none']);
      expect(Qc1008Data.magicLinks(HISTORY.email).some((r) => r.clientId !== QC1008_CLIENT)).toBe(true);
      expect(Qc1008Data.refusals(HISTORY.email).some((r) => r.clientId !== QC1008_CLIENT)).toBe(true);

      const log = await api.emailLog('manageusers', ids.history);
      expect(log.status, log.text).toBe(200);
      expect(log.data!.items).toHaveLength(4);
      expect(log.text).not.toContain('e2e-qc1008');
      await adminUserFormPage.open(ids.history);
      await expect(adminUserFormPage.emails.items).toHaveCount(4);
    });

    test('USEM-10 the log is newest first and every date is the Host time zone as MM/dd/yyyy hh:mmtt, in the page and in the API', async ({ adminUserFormPage }) => {
      const reset = Qc1008Data.resetLinks(HISTORY.email).find((r) => r.clientId === QC1008_CLIENT)!;
      const link = Qc1008Data.magicLinks(HISTORY.email).find((r) => r.clientId === QC1008_CLIENT)!;
      const refusal = Qc1008Data.refusals(HISTORY.email).find((r) => r.clientId === QC1008_CLIENT)!;
      const invite = Qc1008Data.inviteCreated(ids.history);
      const expected = [refusal.created, link.created, reset.created, invite].map((d) => formatAppDateTime(d, env.appTimeZone!));
      expect(new Set(expected).size, 'the four seeded times differ').toBe(4);

      await adminUserFormPage.open(ids.history);
      expect(await adminUserFormPage.emails.expectDatesFormatted()).toEqual(expected);
      const log = await api.emailLog('manageusers', ids.history);
      expect(log.data!.items.map((i) => i.at)).toEqual(expected);
      expect(log.data!.items.map((i) => i.text)).toEqual(expectedLines());
    });

    test("USEM-08 Identity's Host-only API answers 401 to no token, a garbage token, an unsigned token and tokens signed with an unknown key, and saves nothing", async ({
      identityHostApi,
    }) => {
      const subject = Qc1008Data.identityUserId(HISTORY.email);
      const before = Qc1008Data.resetLinks(HISTORY.email).length;
      for (const forged of identityHostApi.forgedTokens(Qc913Data.hostUuid())) {
        expect(await identityHostApi.resetStatus(subject, forged.header), `password-reset with ${forged.label}`).toBe(401);
        expect(await identityHostApi.logStatus(subject, forged.header), `email-log with ${forged.label}`).toBe(401);
      }
      expect(Qc1008Data.resetLinks(HISTORY.email), 'no reset row was saved').toHaveLength(before);
      expect(Qc1008Data.refusals(HISTORY.email)).toHaveLength(2);
    });
  });

  test('USEM-09 the Vendor Portal user page has the same button and log for the vendor own user (api/vendor/...): email-off, then too many requests', async ({ browser }) => {
    const vendor = seedQc913Login('vendor', false);
    seedQc913Vendor(vendor);
    seedQc913Login(VENDOR_USER.email.replace(/^e2e\.qc913\./, '').replace(/@example\.com$/, ''), false);
    const vendorName = Qc1008Data.hostUserName(vendor.userId);
    const truck = Qc913Data.vendorTruck(1);
    const portal = await VendorPortalSession.signIn(browser, vendor);
    try {
      await portal.form.open();
      await portal.form.fillPerson(VENDOR_USER.email, VENDOR_USER.firstName, VENDOR_USER.lastName);
      await portal.form.chooseTruck(truck.name);
      const userId = await portal.form.saveNew();
      await portal.form.signIn.expectStatus('not-invited');
      await portal.form.emails.expectNoSendButton();
      Qc1008Data.seedHostUser(VENDOR_USER.email, true);
      const vendorApi = api.withToken(await portal.accessToken());
      await expect.poll(async () => (await vendorApi.editForm('vendor', userId)).status, { timeout: 30_000 }).toBe(200);

      await portal.form.open(userId);
      const emails = portal.form.emails;
      await emails.expectSendButton();
      await emails.expectEmpty();

      expect(await emails.pressSend()).toBe(400);
      await emails.expectResult(false, EMAIL_OFF_RESET_SENT(VENDOR_USER.email));
      await expect(emails.errorToast.filter({ hasText: EMAIL_OFF_RESET_SENT(VENDOR_USER.email) })).toBeVisible();
      await emails.expectLines([failedReset(VENDOR_USER.email, `by ${vendorName}`)]);
      expect(Qc1008Data.resetLinks(VENDOR_USER.email)).toEqual([
        expect.objectContaining({ clientId: QC1008_CLIENT, sendStatus: 2, sendFailure: 'email-off', requestedBy: vendor.userId }),
      ]);

      expect(await emails.pressSend()).toBe(400);
      await emails.expectResult(false, RESET_TOO_SOON);
      await emails.expectLines([`Password reset requested by ${vendorName}, not sent: too many requests`, failedReset(VENDOR_USER.email, `by ${vendorName}`)]);

      const log = await vendorApi.emailLog('vendor', userId);
      expect(log.status, log.text).toBe(200);
      expect(log.data!.items).toHaveLength(2);
      const area: UserArea = 'vendor';
      expect((await vendorApi.editForm(area, userId)).data?.invite).toMatchObject({ canSendPasswordReset: true });
    } finally {
      await portal.close();
    }
  });
});
