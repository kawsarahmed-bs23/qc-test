// QC-983: Manage Users refinements after the 17 Nov Dev review (host app, local only). Signs in as the shared host app admin (APP_STATE)
// and only reads, except USRF-02, which presses Save on Create New User with no role and proves that no user was made.
// Seeds six throwaway e2e.qc983.*@example.com users, a vendor with a truck and a customer (seed/host-qc983.apply.sql) and removes
// them again in afterAll (seed/host-qc983.remove.sql). The invite rows for the Invited, Expired and Declined users are seeded only
// when the host database has app.UserInvites (QC-913 migration 202611111200).
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { HostUserInvitesApi } from '@api/user-invites.api';
import { canSeedLocalDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { NOT_SET_UP_MESSAGE, OLD_STATUS_WORDS, STATUS_WORDS } from '@pages/user-refinements.page';

const DOMAIN = '@example.com';
const email = (name: string) => `e2e.qc983.${name}${DOMAIN}`;
const VENDOR = 'E2E QC-983 Vendor';
const TRUCK = 'E2E QC-983 Truck';
const CUSTOMER = 'E2E QC-983 Customer';
const NEW_EMAIL = email('should-not-exist');

function userId(name: string): string {
  const id = querySingleValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email(name)}')`);
  if (!id) throw new Error(`The seeded user ${email(name)} is missing.`);
  return id;
}

function hasInviteTable(): boolean {
  return querySingleValue(`SELECT CASE WHEN OBJECT_ID(N'app.UserInvites', N'U') IS NULL THEN 0 ELSE 1 END`) === '1';
}

function removeSeed(): string {
  return runSeedScript('host-qc983.remove.sql');
}

test.describe('Manage Users refinements (QC-983)', { tag: ['@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 120_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb(), "Needs the host's local database (local only).");
  test.skip(!env.appUrl, 'APP_URL is needed.');

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(200_000);
    removeSeed();
    runSeedScript('host-qc983.apply.sql');
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const api = new HostUserInvitesApi(request).useSession();
      await expect
        .poll(() => api.userEditStatus(userId('driver')), { message: 'the host API sees the seeded truck (it caches the admin organisations for about a minute)', timeout: 120_000, intervals: [5_000] })
        .toBe(200);
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(() => {
    expect(removeSeed()).toMatch(/left=0;leftInvites=0;leftOrganisations=0/);
  });

  test('USRF-01 Create New User starts with a blank Role and an empty Organisation until a role is picked', async ({ userRefinementsFormPage: form, page }) => {
    await form.open();
    await form.expectRoleBlank();
    await form.expectOrganisationEmpty();

    await form.chooseRole('Sales');
    await expect(form.role).toContainText('Sales');
    await page.reload();
    await form.expectRoleBlank();
  });

  test('USRF-02 Save on Create New User with no role is refused with "Role is required" and no user is created', async ({ userRefinementsFormPage: form }) => {
    await form.open();
    form.watchCreates();
    await form.fillPerson(NEW_EMAIL, 'No', 'Role');
    await form.save.click();
    await form.expectRoleRequiredError();
    await expect(form.heading('Create New User', 5).first()).toBeVisible();
    expect(form.createRequests, 'the page did not post user-create').toEqual([]);
    expect(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${NEW_EMAIL}')`), 'no user row was made').toBe('0');
  });

  test('USRF-03 the host API refuses user-create with an empty role and makes no user', async ({ hostUserInvitesApi }) => {
    const api = hostUserInvitesApi.useSession();
    const refused = await api.createUserWithRole({ userName: NEW_EMAIL, firstName: 'No', lastName: 'Role' }, '');
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toMatch(/role/i);
    expect(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${NEW_EMAIL}')`)).toBe('0');
  });

  test('USRF-04 Edit User: Save and Cancel are centred, Sign-In History comes after them and holds the EULA line, status and a blue Send invite', async ({
    userRefinementsFormPage: form,
  }) => {
    await form.open(userId('driver'));
    await form.expectCardOrder();
    await form.expectButtonsCentred();
    await expect(form.historyHeading).toBeVisible();
    await form.expectEulaInHistory();
    await form.signIn.expectSendButton('Send invite');
    await form.expectSendIsPrimary();
  });

  test('USRF-05 the Email hint and the Phone hint carry the new wording on Edit User and Create New User', async ({ userRefinementsFormPage: form }) => {
    await form.open(userId('driver'));
    await form.expectHints();
    await form.open();
    await form.expectHints();
  });

  test('USRF-06 Create New User shows the Sign-In History card with "Save the user, then send the invite from here." and no Send button', async ({
    userRefinementsFormPage: form,
  }) => {
    await form.open();
    await expect(form.historyHeading).toBeVisible();
    await expect(form.createHint).toBeVisible();
    await expect(form.signIn.send).toHaveCount(0);
    await expect(form.cards.last()).toHaveAttribute('id', 'user-signin-history');
  });

  test('USRF-07 invite status wording on Edit User: No Email Invite Sent and Active, and the old words are gone', async ({ userRefinementsFormPage: form }) => {
    await form.open(userId('norole'));
    await form.expectStatusWording('not-invited');
    await form.open(userId('vendor'));
    await form.expectStatusWording('linked');
    await form.signIn.expectNoSendButton();
    for (const old of OLD_STATUS_WORDS) {
      await expect(form.signIn.status.getByText(old, { exact: true })).toHaveCount(0);
    }
  });

  test('USRF-08 invite status wording on Edit User for Email Invite Sent, Email Invite Expired and Declined', async ({ userRefinementsFormPage: form }) => {
    test.skip(!hasInviteTable(), 'The host database has no app.UserInvites (QC-913 migration), so no invite rows could be seeded.');
    await form.open(userId('customer'));
    await form.expectStatusWording('invited');
    await form.open(userId('expired'));
    await form.expectStatusWording('expired');
    await form.open(userId('declined'));
    await form.expectStatusWording('declined');
  });

  test('USRF-09 Users list: the column is "Status", one "Roles" column replaces the six tick columns, and Company stays', async ({ hostUsersListPage: list }) => {
    await list.open();
    const headers = await list.headerTexts();
    expect(headers).toContain('Status');
    expect(headers).toContain('Roles');
    expect(headers).toContain('Company');
    expect(headers).not.toContain('Sign-in');
    for (const gone of ['Admin', 'Accounting', 'Sales', 'Customer', 'Vendor', 'Driver']) {
      expect(headers, `the ${gone} tick column is gone`).not.toContain(gone);
    }
    expect(headers.indexOf('Roles')).toBeLessThan(headers.indexOf('Company'));
  });

  test('USRF-10 Users list: one badge per role, "No role" for a user with none, and the new status words', async ({ hostUsersListPage: list }) => {
    await list.open();
    await list.searchFor('e2e.qc983');
    await expect(list.row(email('driver'))).toHaveCount(1);
    await expect(list.badges(email('customer'))).toHaveText(['Customer', 'Sales'], { ignoreCase: true });
    await expect(list.badges(email('driver'))).toHaveText(['Driver']);
    await expect(list.badges(email('vendor'))).toHaveText(['Vendor']);
    await expect(list.row(email('norole')).getByText('No role', { exact: true })).toBeVisible();
    await expect(list.badges(email('norole'))).toHaveCount(0);
    await expect(list.statusBadge(email('norole'))).toHaveText(STATUS_WORDS['not-invited']);
    await expect(list.statusBadge(email('vendor'))).toHaveText(STATUS_WORDS.linked);
    if (hasInviteTable()) {
      await expect(list.statusBadge(email('customer'))).toHaveText(STATUS_WORDS.invited);
      await expect(list.statusBadge(email('expired'))).toHaveText(STATUS_WORDS.expired);
      await expect(list.statusBadge(email('declined'))).toHaveText(STATUS_WORDS.declined);
    }
  });

  test('USRF-11 Users list: Company of a Driver is the Vendor of the truck, not the truck, and links to that Vendor', async ({ hostUsersListPage: list }) => {
    await list.open();
    await list.searchFor('e2e.qc983');
    await expect(list.company(email('driver'))).toHaveText(VENDOR);
    await expect(list.company(email('driver'))).not.toContainText(TRUCK);
    await expect(list.company(email('driver')).getByRole('link')).toHaveAttribute('href', /\/admin\/vendor\/\d+$/);
    await expect(list.company(email('customer'))).toHaveText(CUSTOMER);
    await expect(list.company(email('vendor'))).toHaveText(VENDOR);
  });

  test('USRF-12 Users list filters: Company is disabled until Role is Customer, Vendor or Driver; a Customer lists its users and a Vendor lists its Drivers', async ({
    hostUsersListPage: list,
  }) => {
    await list.open();
    await expect(list.roleFilter).toBeVisible();
    await expect(list.companyFilter).toBeDisabled();

    await list.searchFor('e2e.qc983');
    await list.chooseRole('Sales');
    await expect(list.companyFilter).toBeDisabled();
    await expect(list.row(email('customer'))).toHaveCount(1);
    await expect(list.row(email('expired'))).toHaveCount(1);
    await expect(list.row(email('driver'))).toHaveCount(0);

    await list.chooseRole('Customer');
    await expect(list.companyFilter).toBeEnabled();
    expect(await list.companyOptions()).toContain(CUSTOMER);
    expect(await list.companyOptions(), 'Customer lists Customers, not Vendors').not.toContain(VENDOR);
    await list.chooseCompany(CUSTOMER);
    await expect(list.rows).toHaveCount(1);
    await expect(list.row(email('customer'))).toHaveCount(1);

    await list.chooseRole('Vendor');
    await expect(list.companyFilter).toBeEnabled();
    expect(await list.companyOptions(), 'Vendor lists Vendors').toContain(VENDOR);
    await list.chooseCompany(VENDOR);
    await expect(list.row(email('vendor'))).toHaveCount(1);
    await expect(list.row(email('driver')), 'a Vendor filter alone does not match Drivers').toHaveCount(0);

    await list.chooseRole('Driver');
    expect(await list.companyOptions(), 'Driver lists Vendors').toContain(VENDOR);
    await list.chooseCompany(VENDOR);
    await expect(list.rows).toHaveCount(1);
    await expect(list.row(email('driver'))).toHaveCount(1);
    await expect(list.company(email('driver'))).toHaveText(VENDOR);
  });

  test('USRF-13 the host API takes role and organisationId on user-search and lists companies per role on user-search-companies', async ({ hostUserInvitesApi }) => {
    const api = hostUserInvitesApi.useSession();
    const customers = await api.userSearchCompanies('Customer');
    expect(customers.status, customers.text).toBe(200);
    expect(customers.text).toContain(CUSTOMER);
    expect(customers.text).not.toContain(VENDOR);
    const drivers = await api.userSearchCompanies('Driver');
    expect(drivers.text).toContain(VENDOR);
    const admins = await api.userSearchCompanies('Admin');
    expect(admins.status, admins.text).toBe(200);
    expect(admins.text).not.toContain(VENDOR);

    const row = await api.searchRow('e2e.qc983', email('driver'));
    expect(row).toMatchObject({ roles: ['Driver'], companyName: VENDOR });
    expect(row?.companyId).toBeGreaterThan(0);
    expect(row?.companyType).toMatch(/vendor/i);
  });

  test("USRF-14 Send invite on a host that cannot send invites says Invites aren't available for this account yet, with no setting names", async ({
    hostUserInvitesApi,
  }) => {
    const readiness = await hostUserInvitesApi.inviteReadiness();
    test.skip(readiness === null, 'ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET are not set.');
    expect(readiness!.status, readiness!.text).toBe(200);
    test.skip(readiness!.data?.ready === true, 'The local host can send invites, so the not-set-up message cannot be reached.');

    const refused = await hostUserInvitesApi.useSession().sendInvite('manageusers', userId('norole'));
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toContain(NOT_SET_UP_MESSAGE);
    expect(refused.text).not.toMatch(/Invites:|SigningKey|ApiPublicUrl|HostUuid|Authority|Missing/);
  });
});
