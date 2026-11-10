import { randomBytes } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue } from '@utils/localDb';
import type { ThrowawayUser } from '@utils/throwawayUsers';
import { HostAdminApi, Qc899HostAdmin, QC899_ADMIN_EMAIL, QC899_ORGANISATION_PREFIX, qc899NewUserEmail } from '@api/host-admin.api';
import { removeSuperAdminRole, seedSuperAdminRole, superAdminRowCounts } from '@pages/host-root-removed.page';
import { env } from '@config/env.config';

const DROPPED_TABLES = [
  'auth.OrganisationAllowedIPs',
  'auth.OrganisationEULADocs',
  'auth.OrganisationSignedEULAs',
  'auth.OrganisationTransferSettings',
  'auth.PasswordHistories',
  'auth.RoleClaims',
  'auth.UserLogins',
  'app.QC780_TemplateBackup',
  'app.QC801_SuperAdminBackup',
];

const DROPPED_COLUMNS: Record<string, string[]> = {
  'auth.Roles': ['ConcurrencyStamp', 'RoleParentId', 'HomePage', 'ReportClassIdFk', 'Discriminator'],
  'auth.Users': ['UnconfirmedEmail', 'Discriminator'],
  'auth.Organisations': ['NationalCode', 'AIFMCurrencyISO', 'IsInvestmentFirm', 'Address', 'CommercialContactName', 'UseClientIDInFileNames'],
};

const KEPT_COLUMNS: Record<string, string[]> = {
  'auth.Users': ['LockoutEnd'],
  'auth.Organisations': ['CommercialContactEmail', 'ClientIdentifier', 'IdentifierLEI'],
};

const NO_SUPERADMIN = { roles: 0, userToRoles: 0, rolesToPermissions: 0, roleClaims: 0 };

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function lines(value: string | null): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function hostNumber(query: string): number {
  return Number(querySingleValue(query) ?? '0');
}

function isMigrated(): boolean {
  return querySingleValue(`SELECT CASE WHEN COL_LENGTH(N'auth.Users', N'Discriminator') IS NULL THEN 1 ELSE 0 END`) === '1';
}

function existingTables(names: string[]): string[] {
  return names.filter((name) => querySingleValue(`SELECT CASE WHEN OBJECT_ID(${sqlText(name)}, N'U') IS NULL THEN 0 ELSE 1 END`) === '1');
}

function existingColumns(columns: Record<string, string[]>): string[] {
  return Object.entries(columns).flatMap(([table, names]) =>
    names
      .filter((name) => querySingleValue(`SELECT CASE WHEN COL_LENGTH(${sqlText(table)}, ${sqlText(name)}) IS NULL THEN 0 ELSE 1 END`) === '1')
      .map((name) => `${table}.${name}`),
  );
}

function backupTables(): string[] {
  return lines(
    querySingleValue(
      `SELECT s.name + '.' + t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id
       WHERE s.name IN (N'auth', N'app', N'dbo') AND (t.name LIKE N'%[_]Backup[_]%' OR t.name LIKE N'QC%Backup') ORDER BY 1`,
    ),
  );
}

function hostUser(email: string): { id: string; passwordHash: string; changed: number; lockoutEnd: string } | null {
  const row = querySingleValue(
    `SELECT CONCAT(Id, '|', PasswordHash, '|', DATEDIFF_BIG(MILLISECOND, '2000-01-01', LastPasswordChangedDate), '|', ISNULL(CONVERT(varchar(33), LockoutEnd, 126), 'null'))
     FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`,
  );
  if (!row) return null;
  const [id, passwordHash, changed, lockoutEnd] = row.split('|');
  return { id, passwordHash, changed: Number(changed), lockoutEnd };
}

function qc899Leftovers(): { hostUsers: number; organisations: number; identityUsers: number } {
  return {
    hostUsers: hostNumber(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC899.%'`),
    organisations: hostNumber(`SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName LIKE N'${QC899_ORGANISATION_PREFIX} %'`),
    identityUsers: Number(querySingleValue(`SELECT COUNT(*) FROM [${env.identitySql!.database}].auth.Users WHERE NormalizedEmail LIKE N'E2E.QC899.%'`)),
  };
}

function strongPassword(): string {
  return `Qc899!${randomBytes(6).toString('hex')}Aa`;
}

test.describe('The host auth schema keeps only what is read (QC-899, D34)', { tag: ['@regression'] }, () => {
  test.skip(env.name !== 'local' || !canSeedLocalDb(), 'Needs the local host database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE).');
  test.skip(canSeedLocalDb() && !isMigrated(), 'The host database has not had remove_unused_auth_objects.sql (QC-899) applied.');

  test('AUTHCLEAN-01 the dropped auth tables, columns and backup tables are gone, LockoutEnd and the kept Organisation columns stay, and Organisation_Children runs without the dropped columns', () => {
    expect(existingTables(DROPPED_TABLES), 'dropped tables still present').toEqual([]);
    expect(existingColumns(DROPPED_COLUMNS), 'dropped columns still present').toEqual([]);
    expect(existingColumns(KEPT_COLUMNS), 'kept columns').toEqual(
      Object.entries(KEPT_COLUMNS).flatMap(([table, names]) => names.map((name) => `${table}.${name}`)),
    );
    expect(backupTables(), 'backup tables left in auth, app or dbo').toEqual([]);

    const children = lines(
      querySingleValue(
        `SELECT name FROM sys.dm_exec_describe_first_result_set(N'EXEC auth.Organisation_Children @ParentId = NULL', NULL, 0) ORDER BY column_ordinal`,
      ),
    );
    expect(children).toEqual(
      expect.arrayContaining(['OrganisationID', 'OrganisationName', 'CommercialContactEmail', 'IdentifierLEI', 'ClientIdentifier', 'IsActive']),
    );
    for (const dropped of DROPPED_COLUMNS['auth.Organisations']) {
      expect(children, `Organisation_Children returns no ${dropped}`).not.toContain(dropped);
    }
    expect(() => querySingleValue('EXEC auth.Organisation_Children @ParentId = NULL'), 'EXEC auth.Organisation_Children @ParentId = NULL runs').not.toThrow();
    const hostOrganisationId = hostNumber(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'`);
    const tree = lines(querySingleValue(`EXEC auth.Organisation_Children @ParentId = ${hostOrganisationId}`));
    expect(tree.length, `EXEC auth.Organisation_Children @ParentId = ${hostOrganisationId} returns the host's organisation tree`).toBeGreaterThan(0);
  });

  test.describe('the QC-899 host API on the cleaned schema', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'default' });
    test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
    test.skip(!env.appApiUrl, 'Needs APP_API_URL (the host API).');

    let admin: ThrowawayUser;
    let api: HostAdminApi;
    let signInStatus = 0;

    test.beforeAll(async () => {
      Qc899HostAdmin.remove();
      admin = Qc899HostAdmin.seed();
      api = await HostAdminApi.open();
      signInStatus = (await api.signInWithPassword(admin.email, admin.password)).status;
    });

    test.afterAll(async () => {
      try {
        await api?.close();
      } finally {
        Qc899HostAdmin.remove();
      }
      expect(qc899Leftovers(), 'no QC-899 user or organisation is left').toEqual({ hostUsers: 0, organisations: 0, identityUsers: 0 });
    });

    test('AUTHCLEAN-02 a host admin signed in at Identity gets a token the QC-899 host API accepts through the identity exchange', async ({
      browser,
      request,
    }) => {
      test.skip(
        !(await HostAdminApi.identityServesHostClient(request)),
        `Identity (${env.identityUrl}) does not start a code flow for ${env.hostClient?.clientId}: it serves no host from HOST_MASTER, so it has no host client to sign in to.`,
      );
      const viaIdentity = await HostAdminApi.open();
      try {
        const exchange = await viaIdentity.signInWith(browser, admin);
        expect(exchange.status, `the identity exchange: ${exchange.text.slice(0, 300)}`).toBe(200);
        const profile = await viaIdentity.profile();
        expect(profile.status, profile.text.slice(0, 300)).toBe(200);
        expect(JSON.stringify(profile.data)).toContain(QC899_ADMIN_EMAIL);
      } finally {
        await viaIdentity.close();
      }
    });

    test('AUTHCLEAN-03 the QC-899 host API loads the signed-in host admin with its role and permissions: profile, EULA, the users list and roles, and the vendor organisations it may set, which come from Organisation_Children', async () => {
      expect(signInStatus, 'the host admin signs in to the host API').toBe(200);

      const profile = await api.profile();
      expect(profile.status, profile.text.slice(0, 300)).toBe(200);
      expect(JSON.stringify(profile.data)).toContain(QC899_ADMIN_EMAIL);
      const eula = await api.userEulaCheck();
      expect(eula.status, eula.text.slice(0, 300)).toBe(200);

      const users = await api.userSearch(QC899_ADMIN_EMAIL);
      expect(users.status, users.text.slice(0, 300)).toBe(200);
      expect(JSON.stringify(users.data), 'the users list has the host admin').toContain(QC899_ADMIN_EMAIL);

      const form = await api.userCreateForm();
      expect(form.status, form.text.slice(0, 300)).toBe(200);
      expect(
        form.data!.availableRoles.map((role) => role.value),
        'the roles list',
      ).toEqual(expect.arrayContaining(['Admin']));

      const options = await api.organisationOptions('Vendor');
      expect(options.status, options.text.slice(0, 300)).toBe(200);
      expect(options.data!.availableOrganisations.length, 'vendor organisations under the host organisation').toBeGreaterThan(0);
    });

    test('AUTHCLEAN-04 the vendor list and opening a vendor, which check organisation access through Organisation_Children, answer 200', async () => {
      const vendors = await api.vendorSearch();
      expect(vendors.status, vendors.text.slice(0, 300)).toBe(200);
      const firstVendor = (vendors.data?.data ?? [])[0];
      expect(firstVendor, 'the vendor list has an organisation to open').toBeTruthy();
      const opened = await api.vendorEditForm(firstVendor.organisationId);
      expect(opened.status, `vendor-edit/${firstVendor.organisationId}: ${opened.text.slice(0, 300)}`).toBe(200);
      expect(opened.data!.organisationName).toBe(firstVendor.organisationName);
    });

    test('AUTHCLEAN-05 a vendor organisation is created and edited through the host API without the dropped Organisation columns', async () => {
      const name = `${QC899_ORGANISATION_PREFIX} Vendor ${randomBytes(3).toString('hex')}`;
      const form = await api.vendorCreateForm();
      expect(form.status, form.text.slice(0, 300)).toBe(200);

      const location = {
        ...(form.data!.location ?? {}),
        organisationLocationName: `${QC899_ORGANISATION_PREFIX} Yard`,
        organisationLocationAddr1: '1 E2E Quarry Rd',
        organisationLocationCity: 'Austin',
        organisationLocationState: 'TX',
        organisationLocationZip: '78701',
      };
      const created = await api.createVendor({ ...form.data!, organisationName: name, telephone: '5125550199', isActive: true, location });
      expect([200, 201], created.text.slice(0, 500)).toContain(created.status);
      const organisationId = hostNumber(`SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = ${sqlText(name)}`);
      expect(organisationId, 'the new vendor is in auth.Organisations').toBeGreaterThan(0);

      const opened = await api.vendorEditForm(organisationId);
      expect(opened.status, opened.text.slice(0, 300)).toBe(200);
      expect(opened.data!.organisationName).toBe(name);

      const edited = `${name} edited`;
      const saved = await api.editVendor({ ...opened.data!, organisationName: edited, website: 'https://e2e-qc899.example.com', location });
      expect(saved.status, saved.text.slice(0, 500)).toBe(200);
      expect(
        querySingleValue(`SELECT CONCAT(OrganisationName, '|', Website, '|', IsActive) FROM auth.Organisations WHERE OrganisationID = ${organisationId}`),
      ).toBe(`${edited}|https://e2e-qc899.example.com|1`);

      const reopened = await api.vendorEditForm(organisationId);
      expect(reopened.status, reopened.text.slice(0, 300)).toBe(200);
      expect(reopened.data!.organisationName).toBe(edited);
    });

    test('AUTHCLEAN-06 a host user is created with a role through the host API and opens with that role', async () => {
      const email = qc899NewUserEmail('created');
      const password = strongPassword();
      const created = await api.createUser({ userName: email, firstName: 'E2E', lastName: 'QC-899 Created', role: 'Sales', password });
      expect([200, 201], created.text.slice(0, 500)).toContain(created.status);

      const row = hostUser(email);
      expect(row, 'the new user is in auth.Users').not.toBeNull();
      expect(querySingleValue(`SELECT STRING_AGG(RoleName, ',') FROM auth.UserToRoles WHERE UserId = ${sqlText(row!.id)}`)).toBe('Sales');

      const opened = await api.userEditForm(row!.id);
      expect(opened.status, opened.text.slice(0, 300)).toBe(200);
      expect(opened.data!.userName).toBe(email);
      expect(opened.data!.role).toBe('Sales');

      const listed = await api.userSearch(email);
      expect(listed.status).toBe(200);
      expect(JSON.stringify(listed.data)).toContain(email);
    });

    test('AUTHCLEAN-07 a password change through the host API saves a new hash with no auth.PasswordHistories, and changing back to the old password is allowed', async () => {
      expect(querySingleValue(`SELECT CASE WHEN OBJECT_ID(N'auth.PasswordHistories', N'U') IS NULL THEN 0 ELSE 1 END`)).toBe('0');
      const before = hostUser(QC899_ADMIN_EMAIL)!;
      const next = strongPassword();

      const wrong = await api.changePassword(`${admin.password}x`, next);
      expect(wrong.status, wrong.text.slice(0, 300)).toBe(400);
      expect(hostUser(QC899_ADMIN_EMAIL)!.passwordHash, 'a refused change keeps the hash').toBe(before.passwordHash);

      const changed = await api.changePassword(admin.password, next);
      expect(changed.status, changed.text.slice(0, 300)).toBe(200);
      const after = hostUser(QC899_ADMIN_EMAIL)!;
      expect(after.passwordHash, 'a new hash is stored').not.toBe(before.passwordHash);
      expect(after.changed > before.changed, `LastPasswordChangedDate moves on (${before.changed} -> ${after.changed})`).toBe(true);

      const back = await api.changePassword(next, admin.password);
      expect(back.status, `changing back to the previous password: ${back.text.slice(0, 300)}`).toBe(200);
      expect(hostUser(QC899_ADMIN_EMAIL)!.passwordHash).not.toBe(after.passwordHash);
    });

    test('AUTHCLEAN-08 a host user locked out through auth.Users.LockoutEnd is refused with 423 Locked, and signs in again once LockoutEnd is cleared', async () => {
      const original = hostUser(QC899_ADMIN_EMAIL)!.lockoutEnd;
      const probe = await HostAdminApi.open();
      try {
        querySingleValue(
          `UPDATE auth.Users SET LockoutEnd = DATEADD(HOUR, 1, SYSDATETIMEOFFSET()) WHERE NormalizedEmail = UPPER(${sqlText(QC899_ADMIN_EMAIL)})`,
        );
        const refused = await probe.signInWithPassword(admin.email, admin.password);
        expect(refused.status, `a locked-out host user: ${refused.text.slice(0, 300)}`).toBe(423);
        expect(refused.text).toContain('locked out');
      } finally {
        querySingleValue(
          `UPDATE auth.Users SET LockoutEnd = ${original === 'null' ? 'NULL' : sqlText(original)} WHERE NormalizedEmail = UPPER(${sqlText(QC899_ADMIN_EMAIL)})`,
        );
      }
      try {
        expect(hostUser(QC899_ADMIN_EMAIL)!.lockoutEnd, 'LockoutEnd is back to its original value').toBe(original);
        const again = await probe.signInWithPassword(admin.email, admin.password);
        expect(again.status, again.text.slice(0, 300)).toBe(200);
      } finally {
        await probe.close();
      }
    });

    test('AUTHCLEAN-09 the QC-801 SuperAdmin role seed and remove scripts work with no RoleClaims, no SuperAdmin backup and no Roles.Discriminator, and leave no SuperAdmin row', () => {
      test.skip(superAdminRowCounts().roles > 0, 'A SuperAdmin role is already in the host database; it was not seeded by this run.');
      try {
        seedSuperAdminRole();
        expect(superAdminRowCounts()).toEqual({ roles: 1, userToRoles: 0, rolesToPermissions: 1, roleClaims: 0 });
      } finally {
        removeSuperAdminRole();
      }
      expect(superAdminRowCounts()).toEqual(NO_SUPERADMIN);
    });
  });
});
