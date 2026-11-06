import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { test, expect } from '../fixtures/test';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseIdentityDb,
  queryDriversDb,
  queryIdentityDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '../fixtures/localDb';
import { newAuthenticatorKey } from '../fixtures/totp';
import {
  DriverInvitesApi,
  DriverInvitesPage,
  HostDriverInvitesApi,
  INVITE_NOT_AVAILABLE,
  INVITE_SENT,
  QC774_VENDOR_STATE,
  inviteCode,
  inviteTokenHash,
  waitForInviteEmail,
} from '../pages/DriverInvitesApi';
import { MailSink } from '../pages/HostPasswordLink';
import { isDriversApiReachable, PasswordGrantApi } from '../pages/PasswordGrantApi';
import { env } from '../config/environment';

const VENDOR_EMAIL = 'e2e.qc774.vendor@quarryconnect.test';
const DRIVER_EMAILS = {
  first: 'e2e.qc774.driver1@quarryconnect.test',
  second: 'e2e.qc774.driver2@quarryconnect.test',
  other: 'e2e.qc774.driver3@quarryconnect.test',
  fourth: 'e2e.qc774.driver4@quarryconnect.test',
} as const;
const UNKNOWN_EMAIL = 'e2e.qc774.nobody@quarryconnect.test';
const UI_EMAIL = 'e2e.qc774.ui@quarryconnect.test';
const MESSAGE_WINDOW = 30_000;
const POLL = { intervals: [500, 1_000, 2_000] };

type DriverKey = keyof typeof DRIVER_EMAILS;

interface Driver {
  email: string;
  sub: string;
  api: DriverInvitesApi;
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function hostValue(query: string): string | null {
  return querySingleValue(query);
}

function driversValue(query: string): string | null {
  return queryDriversDb(query);
}

function existingThrowawayUsers(): string {
  return (queryIdentityDb(`SELECT STRING_AGG(Id, ',') FROM Users WHERE NormalizedEmail LIKE N'E2E.QC774.%@QUARRYCONNECT.TEST'`) ?? 'none') || 'none';
}

function removeAll(userIds: string): void {
  runDriversSeedScript('drivers-qc774.remove.sql', { UserIds: userIds });
  runSeedScript('host-qc774.remove.sql', { UserIds: userIds });
  runIdentitySeedScript('identity-qc774.remove.sql');
}

function linkState(sub: string, hostUuid: string): string {
  return driversValue(
    `SELECT CONCAT(COUNT(*), ':', ISNULL(SUM(CAST(l.Active AS int)), 0)) FROM app.DriverHostLinks l JOIN app.Hosts h ON h.HostID = l.HostID_FK WHERE l.UserID_FK = ${sqlText(sub)} AND h.HostUUID = '${hostUuid}'`,
  )!;
}

function otherDriversLinks(hostUuid: string, subs: string[]): string {
  return driversValue(
    `SELECT CONCAT(COUNT(*), ':', ISNULL(SUM(CAST(l.Active AS int)), 0)) FROM app.DriverHostLinks l JOIN app.Hosts h ON h.HostID = l.HostID_FK WHERE h.HostUUID = '${hostUuid}' AND l.UserID_FK NOT IN (${subs.map(sqlText).join(', ')})`,
  )!;
}

function driversInviteStatus(inviteUuid: string): number {
  return Number(driversValue(`SELECT Status FROM app.DriverInvites WHERE DriverInviteUUID = '${inviteUuid}'`) ?? '0');
}

function hostUser(sub: string): { active: string; organisationId: string; roles: string; hasPassword: string } | null {
  const row = hostValue(
    `SELECT CONCAT(CAST(u.IsActive AS int), '|', u.OrganisationIdFk, '|', (SELECT STRING_AGG(RoleName, ',') FROM auth.UserToRoles r WHERE r.UserId = u.Id), '|', CASE WHEN u.PasswordHash IS NULL THEN 0 ELSE 1 END) FROM auth.Users u WHERE u.Id = ${sqlText(sub)}`,
  );
  if (!row) return null;
  const [active, organisationId, roles, hasPassword] = row.split('|');
  return { active, organisationId, roles, hasPassword };
}

test.describe('Driver invites link a host and a driver only with the driver\'s approval (QC-774)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
  test.skip(!env.admin, 'Needs ADMIN_EMAIL / ADMIN_PASSWORD; the throwaway users copy that password.');
  test.skip(!env.appApiUrl || !env.driversApiUrl, 'Needs APP_API_URL and DRIVERS_API_URL.');

  let hostUuid = '';
  let vendorKey = '';
  let trucks: { first: number; second: number; foreign: number };
  let host: HostDriverInvitesApi;
  let otherHostLinks = '';
  let secondHostUuid = '';
  let mailSink = false;
  const drivers = {} as Record<DriverKey, Driver>;
  const invites: { first?: string; second?: string } = {};

  test.beforeAll(async ({ playwright, targetHost }) => {
    test.setTimeout(180_000);
    hostUuid = targetHost.uuid.toLowerCase();
    removeAll(existingThrowawayUsers());

    const probe = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(probe)), 'The drivers API (DRIVERS_API_URL) is not running.');
    } finally {
      await probe.dispose();
    }
    mailSink = await MailSink.isListening();

    vendorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc774-user.apply.sql', {
      Email: VENDOR_EMAIL, SourceEmail: env.admin!.email, LastName: 'QC-774 Vendor', TwoFactor: '1', AuthenticatorKey: vendorKey,
    });
    const vendorId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(${sqlText(VENDOR_EMAIL)})`);
    expect(vendorId, 'the throwaway Identity vendor exists').not.toBeNull();
    runSeedScript('host-qc774-vendor.apply.sql', { UserId: vendorId!, Email: VENDOR_EMAIL, IdentityDb: env.identitySql!.database });

    const vendorOrg = hostValue(`SELECT OrganisationIdFk FROM auth.Users WHERE Id = ${sqlText(vendorId!)}`)!;
    trucks = {
      first: Number(hostValue(`SELECT OrganisationID FROM auth.Organisations WHERE ParentOrganisationIdFk = ${vendorOrg} AND OrganisationName = N'E2E QC-774 Truck 1'`)),
      second: Number(hostValue(`SELECT OrganisationID FROM auth.Organisations WHERE ParentOrganisationIdFk = ${vendorOrg} AND OrganisationName = N'E2E QC-774 Truck 2'`)),
      foreign: Number(hostValue(
        `SELECT TOP 1 t.OrganisationID FROM auth.Organisations t JOIN auth.RoleTypes rt ON rt.RoleTypeId = t.RoleTypeIdFk WHERE rt.RoleType = N'Truck' AND t.ParentOrganisationIdFk <> ${vendorOrg} ORDER BY t.OrganisationID`,
      ) ?? '0'),
    };
    expect(trucks.first).toBeGreaterThan(0);
    expect(trucks.second).toBeGreaterThan(0);

    for (const key of Object.keys(DRIVER_EMAILS) as DriverKey[]) {
      runIdentitySeedScript('identity-qc774-user.apply.sql', {
        Email: DRIVER_EMAILS[key], SourceEmail: env.admin!.email, LastName: `QC-774 Driver ${key}`, TwoFactor: '0', AuthenticatorKey: 'none',
      });
      const sub = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(${sqlText(DRIVER_EMAILS[key])})`);
      expect(sub, `the throwaway Identity driver ${key} exists`).not.toBeNull();
      const grantContext = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        const token = await new PasswordGrantApi(grantContext).passwordGrant(DRIVER_EMAILS[key], env.admin!.password);
        expect(token.status, `password grant for ${key}: ${token.body.error ?? ''} ${token.body.error_description ?? ''}`).toBe(200);
        drivers[key] = {
          email: DRIVER_EMAILS[key],
          sub: sub!.toLowerCase(),
          api: new DriverInvitesApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }), token.body.access_token!),
        };
      } finally {
        await grantContext.dispose();
      }
    }

    secondHostUuid = randomUUID();
    runDriversSeedScript('drivers-qc774.apply.sql', { UserId: drivers.first.sub, SecondHostUuid: secondHostUuid });
    otherHostLinks = otherDriversLinks(hostUuid, Object.values(drivers).map((d) => d.sub));

    host = new HostDriverInvitesApi(await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }));
    expect(await host.signIn(VENDOR_EMAIL, env.admin!.password), 'the throwaway vendor signs in to the host API').toBe(200);
  });

  test.afterAll(async () => {
    const subs = Object.values(drivers).map((d) => d.sub).join(',') || 'none';
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    removeAll(subs);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    removeAll(subs);
    fs.rmSync(QC774_VENDOR_STATE, { force: true });
  });

  test('DINV-01 an email invite is emailed as an i- link, listed for that driver, accepted by code, and links the driver on both sides', async () => {
    test.skip(!mailSink, 'The SMTP sink (127.0.0.1:2525, scripts/smtp-sink.mjs) is not running.');
    const driver = drivers.first;
    const since = MailSink.mark();

    const sent = await host.send({ invitedEmail: driver.email, truckId: trucks.first });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.message).toBe(INVITE_SENT);
    expect(sent.data?.status).toBe('pending');
    expect(sent.data?.truckName).toBe('E2E QC-774 Truck 1');
    const inviteUuid = sent.data!.inviteUuid.toLowerCase();
    invites.first = inviteUuid;

    const mail = await waitForInviteEmail(driver.email, since);
    const code = inviteCode(mail);
    expect(code).toMatch(/^i-[A-Za-z0-9_-]{40,}$/);
    expect(driversValue(`SELECT TokenHash FROM app.DriverInvites WHERE DriverInviteUUID = '${inviteUuid}'`), 'only the SHA-256 of the token is stored').toBe(inviteTokenHash(code));
    expect(driversValue(`SELECT COUNT(*) FROM app.DriverInvites WHERE TokenHash = ${sqlText(code.slice(2))} OR InvitedEmail = ${sqlText(code)}`)).toBe('0');

    const listed = (await driver.api.list()).data?.invites.find((invite) => invite.inviteUuid.toLowerCase() === inviteUuid);
    expect(listed, 'the invite is in GET /invites for the invited email').toBeTruthy();
    expect(listed!.hostUuid.toLowerCase()).toBe(hostUuid);

    const accepted = await driver.api.acceptCode(code);
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.data?.hostUuid.toLowerCase()).toBe(hostUuid);
    expect(linkState(driver.sub, hostUuid), 'one active DRIVERS link for the driver and the host').toBe('1:1');
    expect(driversInviteStatus(inviteUuid)).toBe(20);
    expect(await driver.api.listedUuids()).not.toContain(inviteUuid);
    expect((await driver.api.acceptCode(code)).status, 'the link works once').toBe(404);

    await expect.poll(async () => (await host.find(inviteUuid))?.status, { message: 'the host marks the invite accepted', timeout: MESSAGE_WINDOW, ...POLL }).toBe('accepted');
    expect((await host.find(inviteUuid))?.driverUuid?.toLowerCase()).toBe(driver.sub);
    expect(hostUser(driver.sub)).toEqual({ active: '1', organisationId: String(trucks.first), roles: 'Driver', hasPassword: '0' });
  });

  test('DINV-02 an invite by driver UUID sends no email, is listed for that driver and is accepted with one tap', async () => {
    const driver = drivers.second;
    const since = MailSink.mark();

    const sent = await host.send({ invitedDriverUuid: driver.sub, truckId: trucks.second });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.message).toBe(INVITE_SENT);
    const inviteUuid = sent.data!.inviteUuid.toLowerCase();
    invites.second = inviteUuid;

    await expect.poll(() => driver.api.listedUuids(), { message: 'the UUID invite reaches GET /invites', timeout: MESSAGE_WINDOW, ...POLL }).toContain(inviteUuid);
    expect(driversValue(`SELECT CONCAT(CASE WHEN InvitedEmail IS NULL THEN 'null' ELSE InvitedEmail END, '|', CASE WHEN TokenHash IS NULL THEN 'null' ELSE 'hash' END, '|', InvitedUserID) FROM app.DriverInvites WHERE DriverInviteUUID = '${inviteUuid}'`)).toBe(`null|null|${driver.sub}`);
    expect(MailSink.newTo(driver.email, since), 'no email for a UUID invite').toHaveLength(0);

    const accepted = await driver.api.accept(inviteUuid);
    expect(accepted.status, accepted.text).toBe(200);
    expect(accepted.data?.hostUuid.toLowerCase()).toBe(hostUuid);
    expect(linkState(driver.sub, hostUuid)).toBe('1:1');

    await expect.poll(async () => (await host.find(inviteUuid))?.status, { timeout: MESSAGE_WINDOW, ...POLL }).toBe('accepted');
    expect(hostUser(driver.sub)).toEqual({ active: '1', organisationId: String(trucks.second), roles: 'Driver', hasPassword: '0' });
  });

  test('DINV-03 a driver signed in with another email can neither see nor accept an email invite', async () => {
    test.skip(!mailSink, 'The SMTP sink (127.0.0.1:2525) is not running.');
    const invited = drivers.fourth;
    const other = drivers.other;
    const since = MailSink.mark();

    const sent = await host.send({ invitedEmail: invited.email, truckId: trucks.first });
    expect(sent.status, sent.text).toBe(200);
    const inviteUuid = sent.data!.inviteUuid.toLowerCase();
    const code = inviteCode(await waitForInviteEmail(invited.email, since));

    expect(await other.api.listedUuids()).not.toContain(inviteUuid);
    for (const attempt of [await other.api.accept(inviteUuid), await other.api.acceptCode(code), await other.api.decline(inviteUuid)]) {
      expect(attempt.status, attempt.text).toBe(404);
      expect(attempt.errors).toEqual([INVITE_NOT_AVAILABLE]);
    }
    expect(driversInviteStatus(inviteUuid), 'the invite is still pending').toBe(10);
    expect(linkState(other.sub, hostUuid)).toBe('0:0');
    expect(await invited.api.listedUuids(), 'the invited driver still sees it').toContain(inviteUuid);
    expect((await host.cancel(inviteUuid)).status).toBe(200);
  });

  test('DINV-04 an expired invite is refused for the driver and shown as expired on the host', async () => {
    test.skip(!mailSink, 'The SMTP sink (127.0.0.1:2525) is not running.');
    const driver = drivers.fourth;
    const since = MailSink.mark();

    const sent = await host.send({ invitedEmail: driver.email, truckId: trucks.first });
    expect(sent.status, sent.text).toBe(200);
    const inviteUuid = sent.data!.inviteUuid.toLowerCase();
    const code = inviteCode(await waitForInviteEmail(driver.email, since));
    expect(await driver.api.listedUuids()).toContain(inviteUuid);

    driversValue(`UPDATE app.DriverInvites SET ExpiresAt = DATEADD(MINUTE, -1, GETUTCDATE()) WHERE DriverInviteUUID = '${inviteUuid}'`);
    hostValue(`UPDATE app.DriverInvites SET ExpiresAt = DATEADD(MINUTE, -1, GETUTCDATE()) WHERE DriverInviteUUID = '${inviteUuid}'`);

    expect(await driver.api.listedUuids()).not.toContain(inviteUuid);
    for (const attempt of [await driver.api.acceptCode(code), await driver.api.accept(inviteUuid)]) {
      expect(attempt.status, attempt.text).toBe(404);
      expect(attempt.errors).toEqual([INVITE_NOT_AVAILABLE]);
    }
    expect(linkState(driver.sub, hostUuid)).toBe('0:0');
    expect((await host.find(inviteUuid))?.status).toBe('expired');
  });

  test('DINV-05 a resend retires the old token and invite UUID and the new one works', async () => {
    test.skip(!mailSink, 'The SMTP sink (127.0.0.1:2525) is not running.');
    const driver = drivers.fourth;
    let since = MailSink.mark();

    const sent = await host.send({ invitedEmail: driver.email, truckId: trucks.second });
    expect(sent.status, sent.text).toBe(200);
    const oldUuid = sent.data!.inviteUuid.toLowerCase();
    const oldCode = inviteCode(await waitForInviteEmail(driver.email, since));

    since = MailSink.mark();
    const resent = await host.resend(oldUuid);
    expect(resent.status, resent.text).toBe(200);
    expect(resent.message).toBe(INVITE_SENT);
    const newUuid = resent.data!.inviteUuid.toLowerCase();
    expect(newUuid).not.toBe(oldUuid);
    expect(hostValue(`SELECT LOWER(CONVERT(nvarchar(36), ReplacesInviteUUID)) FROM app.DriverInvites WHERE DriverInviteUUID = '${newUuid}'`)).toBe(oldUuid);
    const newCode = inviteCode(await waitForInviteEmail(driver.email, since));
    expect(newCode).not.toBe(oldCode);

    expect((await host.find(oldUuid))?.status).toBe('cancelled');
    expect((await host.find(newUuid))?.status).toBe('pending');
    expect(driversInviteStatus(oldUuid)).toBe(30);
    expect((await host.resend(oldUuid)).status, 'a cancelled invite cannot be resent').toBe(400);

    for (const attempt of [await driver.api.acceptCode(oldCode), await driver.api.accept(oldUuid)]) {
      expect(attempt.status, attempt.text).toBe(404);
      expect(attempt.errors).toEqual([INVITE_NOT_AVAILABLE]);
    }
    expect(linkState(driver.sub, hostUuid)).toBe('0:0');

    const accepted = await driver.api.acceptCode(newCode.slice(2));
    expect(accepted.status, `the code without its i- prefix: ${accepted.text}`).toBe(200);
    expect(linkState(driver.sub, hostUuid)).toBe('1:1');
    await expect.poll(async () => (await host.find(newUuid))?.status, { timeout: MESSAGE_WINDOW, ...POLL }).toBe('accepted');
    expect((await host.find(oldUuid))?.status).toBe('cancelled');
    expect(hostUser(driver.sub)?.organisationId).toBe(String(trucks.second));
  });

  test('DINV-06 a host revoke ends the link on both sides and leaves the driver\'s other host links alone', async () => {
    test.skip(!invites.first, 'DINV-01 did not link the first driver.');
    const driver = drivers.first;
    const inviteUuid = invites.first!;
    expect(linkState(driver.sub, secondHostUuid), 'the seeded link to the second host').toBe('1:1');

    const revoked = await host.revoke(inviteUuid);
    expect(revoked.status, revoked.text).toBe(200);
    expect(revoked.message).toBe('Driver unlinked.');
    expect((await host.find(inviteUuid))?.status).toBe('revoked');
    expect(hostUser(driver.sub)?.active, 'the host driver user is deactivated').toBe('0');

    await expect.poll(() => linkState(driver.sub, hostUuid), { message: 'DRIVERS ends the link to this host', timeout: MESSAGE_WINDOW, ...POLL }).toBe('1:0');
    expect(linkState(driver.sub, secondHostUuid), 'the link to the other host is untouched').toBe('1:1');
    expect(otherDriversLinks(hostUuid, Object.values(drivers).map((d) => d.sub)), 'other drivers\' links to this host are unchanged').toBe(otherHostLinks);
    expect((await host.revoke(inviteUuid)).status, 'a revoked invite has no link to revoke').toBe(400);
  });

  test('DINV-07 a driver who leaves the host is unlinked there and the host invite becomes revoked', async () => {
    test.skip(!invites.second, 'DINV-02 did not link the second driver.');
    const driver = drivers.second;
    const inviteUuid = invites.second!;

    const left = await driver.api.leaveHost(hostUuid);
    expect(left.status, left.text).toBe(200);
    expect(linkState(driver.sub, hostUuid)).toBe('1:0');

    await expect.poll(async () => (await host.find(inviteUuid))?.status, { message: 'the host hears LinkRevoked', timeout: MESSAGE_WINDOW, ...POLL }).toBe('revoked');
    await expect.poll(() => hostUser(driver.sub)?.active, { timeout: MESSAGE_WINDOW, ...POLL }).toBe('0');
    expect((await driver.api.leaveHost(hostUuid)).status, 'leaving twice is a 404').toBe(404);
  });

  test('DINV-08 the host answers an unknown email exactly like an existing driver\'s email', async () => {
    const unknown = await host.send({ invitedEmail: UNKNOWN_EMAIL, truckId: trucks.first });
    const known = await host.send({ invitedEmail: drivers.other.email, truckId: trucks.first });

    expect(unknown.status, unknown.text).toBe(200);
    expect(known.status, known.text).toBe(200);
    expect(known.message).toBe(unknown.message);
    expect(unknown.message).toBe(INVITE_SENT);
    expect(Object.keys(known.data ?? {}).sort()).toEqual(Object.keys(unknown.data ?? {}).sort());
    expect(known.data?.status).toBe(unknown.data?.status);
    expect(known.data?.driverUuid ?? null).toBeNull();
    expect(unknown.data?.driverUuid ?? null).toBeNull();

    for (const invite of [unknown.data!, known.data!]) {
      const cancelled = await host.cancel(invite.inviteUuid);
      expect(cancelled.status, cancelled.text).toBe(200);
      expect((await host.cancel(invite.inviteUuid)).status, 'cancelling twice is a 400').toBe(400);
    }
  });

  test('DINV-09 a driver who accepts an invite the host already cancelled is unlinked again by the host', async () => {
    const driver = drivers.other;

    const sent = await host.send({ invitedDriverUuid: driver.sub, truckId: trucks.first });
    expect(sent.status, sent.text).toBe(200);
    const inviteUuid = sent.data!.inviteUuid.toLowerCase();
    await expect.poll(() => driver.api.listedUuids(), { timeout: MESSAGE_WINDOW, ...POLL }).toContain(inviteUuid);

    const cancelled = await host.cancel(inviteUuid);
    expect(cancelled.status, cancelled.text).toBe(200);
    expect((await host.find(inviteUuid))?.status).toBe('cancelled');

    const accepted = await driver.api.accept(inviteUuid);
    expect(accepted.status, accepted.text).toBe(200);

    await expect.poll(() => linkState(driver.sub, hostUuid), { message: 'the host answers LinkRevoked and DRIVERS ends the link', timeout: MESSAGE_WINDOW, ...POLL }).toBe('1:0');
    expect((await host.find(inviteUuid))?.status).toBe('cancelled');
    expect(hostUser(driver.sub), 'no host driver user for a cancelled invite').toBeNull();
  });

  test('DINV-10 the host refuses an invite with both or neither invitee, or a truck of another vendor', async () => {
    const both = await host.send({ invitedEmail: UNKNOWN_EMAIL, invitedDriverUuid: drivers.other.sub, truckId: trucks.first });
    expect(both.status, both.text).toBe(400);
    const neither = await host.send({ truckId: trucks.first });
    expect(neither.status, neither.text).toBe(400);
    test.skip(trucks.foreign === 0, 'No truck of another vendor exists locally.');
    const foreign = await host.send({ invitedEmail: UNKNOWN_EMAIL, truckId: trucks.foreign });
    expect(foreign.status, foreign.text).toBe(404);
    expect(hostValue(`SELECT COUNT(*) FROM app.DriverInvites WHERE TruckID_FK = ${trucks.foreign}`)).toBe('0');
  });

  test('DINV-11 the vendor page sends an email invite that shows as Waiting for driver', async ({ browser }) => {
    test.skip(!env.appUrl, 'APP_URL is not set.');
    await DriverInvitesPage.signIn(browser, VENDOR_EMAIL, env.admin!.password, vendorKey);
    const context = await browser.newContext({ baseURL: env.appUrl!, ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: QC774_VENDOR_STATE });
    try {
      const page = await context.newPage();
      const invitesPage = new DriverInvitesPage(page);
      await invitesPage.open();
      await expect(invitesPage.sidebarLink.first()).toBeVisible();
      await expect(invitesPage.unavailable).toHaveCount(0);

      await invitesPage.chooseInviteBy('By email');
      await invitesPage.email.fill(UI_EMAIL);
      await invitesPage.chooseTruck('E2E QC-774 Truck 1');
      await invitesPage.send.click();

      await expect.poll(async () => (await host.list()).data?.find((invite) => invite.invitedEmail === UI_EMAIL)?.inviteUuid, { timeout: 15_000 }).toBeTruthy();
      const inviteUuid = (await host.list()).data!.find((invite) => invite.invitedEmail === UI_EMAIL)!.inviteUuid;
      await expect(invitesPage.row(inviteUuid)).toContainText(UI_EMAIL);
      await expect(invitesPage.status(inviteUuid)).toHaveText('Waiting for driver');
      await expect(invitesPage.row(inviteUuid)).toContainText('E2E QC-774 Truck 1');
    } finally {
      await context.close();
    }
  });
});

