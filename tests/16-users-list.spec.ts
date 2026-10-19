import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, queryMasterDb, runIdentitySeedScript } from '../fixtures/localDb';
import { adminUrl } from '../pages/AdminShell';
import { UserListPage, type UserSortColumn } from '../pages/UserListPage';

const SEARCH = 'e2e.qc742';
const SEEDED = `Email LIKE N'e2e.qc742.%'`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function seeded(n: number): string {
  return `e2e.qc742.u${String(n).padStart(2, '0')}@quarryconnect.test`;
}

function count(where: string): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM Users u WHERE ${where}`));
}

function emails(where: string, orderBy = 'u.Email, u.Id'): string[] {
  return (queryIdentityDb(`SELECT u.Email FROM Users u WHERE ${where} ORDER BY ${orderBy}`) ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function onHost(hostId: number, role?: 'Driver' | 'HostUser'): string {
  return `EXISTS (SELECT 1 FROM app.UserHosts m JOIN Roles r ON r.Id = m.RoleID WHERE m.UserID = u.Id AND m.Active = 1 AND m.HostID = ${hostId}${role ? ` AND r.Name = N'${role}'` : ''})`;
}

function withRole(role: 'Driver' | 'HostUser'): string {
  return `EXISTS (SELECT 1 FROM app.UserHosts m JOIN Roles r ON r.Id = m.RoleID WHERE m.UserID = u.Id AND m.Active = 1 AND r.Name = N'${role}')`;
}

const ORDER: Record<UserSortColumn, Record<'asc' | 'desc', string>> = {
  email: { asc: 'u.Email, u.Id', desc: 'u.Email DESC, u.Id' },
  name: { asc: 'u.LastName, u.FirstName, u.Email, u.Id', desc: 'u.LastName DESC, u.FirstName DESC, u.Email DESC, u.Id' },
  lastLogin: { asc: 'u.LastLoginDate, u.Email, u.Id', desc: 'u.LastLoginDate DESC, u.Email, u.Id' },
};

async function totalOf(list: UserListPage): Promise<number> {
  await expect(list.rangeLabel).toHaveText(/ of \d+ users\s*$/);
  return Number((await list.rangeLabel.innerText()).trim().match(/ of (\d+) users$/)![1]);
}

test.describe('Users list (QC-742)', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canUseIdentityDb(), "Needs Identity's local database to seed the e2e.qc742 users and to count users.");

  let rockRidgeIdentityHost = 0;

  test.beforeAll(() => {
    runIdentitySeedScript('identity-qc742-users.apply.sql');
  });

  test.afterAll(() => {
    runIdentitySeedScript('identity-qc742.remove.sql');
  });

  test.beforeEach(async ({ targetHost }) => {
    test.skip(!canUseMasterDb(), 'Needs MASTER_SQL_DATABASE to find the Identity host behind the target host.');
    rockRidgeIdentityHost = Number(queryMasterDb(`SELECT IdentityHostId FROM app.Hosts WHERE HostUUID = '${targetHost.uuid}'`));
    test.skip(rockRidgeIdentityHost !== 1, 'The seed maps users to Identity host 1, which must be the Identity host of the target host.');
  });

  test('USRLIST-01 the list shows users on arrival, with every Identity account counted and no filters in the URL', { tag: '@smoke' }, async ({ page, shell }) => {
    const list = new UserListPage(page);
    await list.open();
    await expect(shell.heading).toHaveText('Users');
    await expect(page).toHaveURL(adminUrl('/users'));
    await expect(list.rows).toHaveCount(25);
    expect(await totalOf(list)).toBe(count('1 = 1'));
    await expect(list.selected(list.status)).toHaveText('All accounts');
    await expect(list.search).toHaveValue('');
  });

  test('USRLIST-02 search narrows to matching users and is the only thing in the URL', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.searchFor(SEARCH);
    expect(list.query().toString()).toBe(`search=${SEARCH}`);
    expect(await totalOf(list)).toBe(count(SEEDED));
    for (const email of await list.emails()) {
      expect(email).toContain(SEARCH);
    }
  });

  test('USRLIST-03 the host filter alone lists the users mapped to that host', async ({ page, targetHost }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.chooseHost(targetHost.name);
    expect(Object.fromEntries(list.query())).toEqual({ host: targetHost.uuid });
    expect(await totalOf(list)).toBe(count(onHost(rockRidgeIdentityHost)));
    for (const row of await list.rows.all()) {
      await expect(list.cell(row, 'user-hosts').locator(`[data-host-uuid="${targetHost.uuid}" i]`)).toBeVisible();
    }
  });

  test('USRLIST-04 the role filter alone lists Drivers at any host, and Admin as a platform role', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.chooseRole('Driver');
    expect(Object.fromEntries(list.query())).toEqual({ role: 'Driver' });
    expect(await totalOf(list)).toBe(count(withRole('Driver')));

    await list.chooseRole('Admin');
    expect(Object.fromEntries(list.query())).toEqual({ role: 'Admin' });
    const admins = count(`EXISTS (SELECT 1 FROM UserRoles ur JOIN Roles r ON r.Id = ur.RoleId WHERE ur.UserId = u.Id AND r.Name = N'Admin')`);
    await expect(list.rows).toHaveCount(admins);
    for (const row of await list.rows.all()) {
      await expect(list.cell(row, 'user-roles')).toContainText('Admin');
    }
  });

  test('USRLIST-05 the status filter alone lists only deactivated accounts, or only active ones', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.chooseStatus('Deactivated');
    expect(Object.fromEntries(list.query())).toEqual({ status: 'deactivated' });
    await expect(list.rows).toHaveCount(count('u.IsActive = 0'));
    for (const row of await list.rows.all()) {
      await expect(list.cell(row, 'user-account')).toHaveText('Deactivated');
    }

    await list.chooseStatus('Active');
    expect(await totalOf(list)).toBe(count('u.IsActive = 1'));

    await list.chooseStatus('All accounts');
    expect(list.query().toString()).toBe('');
  });

  test('USRLIST-06 search, host, role and status combine, and the role must be held at the chosen host', async ({ page, targetHost }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.searchFor(SEARCH);
    await list.chooseHost(targetHost.name);
    await list.chooseRole('HostUser');
    await list.chooseStatus('Active');
    expect(Object.fromEntries(list.query())).toEqual({ search: SEARCH, host: targetHost.uuid, role: 'HostUser', status: 'active' });

    const expected = emails(`${SEEDED} AND u.IsActive = 1 AND ${onHost(rockRidgeIdentityHost, 'HostUser')}`);
    expect(await list.emails()).toEqual(expected);
    expect(expected).toContain(seeded(26));
    expect(expected).not.toContain(seeded(25));
    expect(expected).not.toContain(seeded(28));
  });

  test('USRLIST-07 filters survive paging with 15 users a page, and the pages hold every match exactly once', async ({ page, targetHost }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, host: targetHost.uuid, role: 'Driver' });
    const expected = emails(`${SEEDED} AND ${onHost(rockRidgeIdentityHost, 'Driver')}`);
    expect(expected.length).toBeGreaterThan(15);

    await list.setPageSize(15);
    await list.waitForQuery((q) => q.get('pageSize') === '15');
    await expect(list.rows).toHaveCount(15);
    const first = await list.emails();

    await list.nextPage();
    await list.waitForQuery((q) => q.get('page') === '2');
    expect(Object.fromEntries(list.query())).toEqual({ search: SEARCH, host: targetHost.uuid, role: 'Driver', page: '2', pageSize: '15' });
    await expect(list.selected(list.role)).toHaveText('Driver');
    await expect(list.search).toHaveValue(SEARCH);
    const second = await list.emails();
    for (const row of await list.rows.all()) {
      await expect(list.cell(row, 'user-hosts').locator(`[data-host-uuid="${targetHost.uuid}" i] .qc-host-role`)).toHaveText(/^Driver/);
    }

    expect([...first, ...second]).toEqual(expected);
    expect(await totalOf(list)).toBe(expected.length);
  });

  for (const [id, column] of [['08', 'name'], ['09', 'email'], ['10', 'lastLogin']] as const) {
    test(`USRLIST-${id} sorting by ${column} works both ways and keeps the filters`, async ({ page }) => {
      const list = new UserListPage(page);
      await list.open({ search: SEARCH, status: 'active', pageSize: 50 });
      const where = `${SEEDED} AND u.IsActive = 1`;

      for (const dir of ['asc', 'desc'] as const) {
        await list.sortBy(column, dir);
        expect(list.query().get('search')).toBe(SEARCH);
        expect(list.query().get('status')).toBe('active');
        expect(list.query().get('pageSize')).toBe('50');
        expect(await list.emails(), `${column} ${dir}`).toEqual(emails(where, ORDER[column][dir]));
      }
    });
  }

  test('USRLIST-11 the URL and every link carry only UUIDs and GUIDs, never a numeric id', async ({ page, targetHost }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, host: targetHost.uuid });
    for (const [key, value] of list.query()) {
      expect(value, key).not.toMatch(/^\d+$/);
    }
    for (const id of await list.userIds()) {
      expect(id).toMatch(GUID);
    }
    for (const href of await list.rows.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))) {
      expect(href).toMatch(/^#\/(users|hosts)\/[0-9a-f-]{36}$/i);
    }

    const row = list.rowByEmail(seeded(1));
    const userId = await row.getAttribute('data-user-id');
    await list.cell(row, 'user-name').click();
    await expect(page).toHaveURL(adminUrl(`/users/${userId}`));
    await expect(page.locator('#user-email')).toHaveText(seeded(1));
  });

  test('USRLIST-12 deactivated accounts are struck through in red, active ones are not', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, pageSize: 50 });

    const deactivated = list.rowByEmail(seeded(7));
    await expect(deactivated).toHaveClass(/qc-deactivated/);
    await expect(list.cell(deactivated, 'user-account')).toHaveText('Deactivated');
    for (const cell of [list.cell(deactivated, 'user-name'), list.cell(deactivated, 'user-email')]) {
      await expect(cell).toHaveClass(/red-strikethrough/);
      await expect(cell).toHaveCSS('text-decoration-line', 'line-through');
      await expect(cell).toHaveCSS('text-decoration-color', 'rgb(255, 0, 0)');
    }

    const active = list.rowByEmail(seeded(1));
    await expect(active).not.toHaveClass(/qc-deactivated/);
    await expect(active.locator('.red-strikethrough')).toHaveCount(0);
    await expect(list.cell(active, 'user-email')).not.toHaveCSS('text-decoration-line', 'line-through');
  });

  test('USRLIST-13 Reset filters clears search, host, role, status, sort and paging', async ({ page, targetHost }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, host: targetHost.uuid, role: 'Driver', status: 'active', sort: 'name', dir: 'desc', page: 2, pageSize: 15 });
    await expect(list.selected(list.role)).toHaveText('Driver');

    await list.reset.click();
    await list.waitForQuery((q) => q.toString() === '');
    await expect(page).toHaveURL(adminUrl('/users'));
    await expect(list.search).toHaveValue('');
    await expect(list.selected(list.status)).toHaveText('All accounts');
    await expect(list.selected(list.role)).toHaveText('All roles');
    await expect(list.selected(list.host)).toHaveText('All hosts');
    expect(await totalOf(list)).toBe(count('1 = 1'));
  });

  test('USRLIST-14 a host UUID that is not registered shows a warning and no users', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ host: '00000000-0000-0000-0000-000000000001' });
    await expect(list.unknownHost).toContainText('That host is not registered here or is not linked to Identity.');
    await expect(list.rows).toHaveCount(0);
    await expect(list.empty).toBeVisible();
  });

  test('USRLIST-15 a search that matches nobody shows the empty state and no pager', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.searchFor('zz-no-such-user-zz');
    await expect(list.empty).toHaveText('No users match these filters.');
    await expect(list.rows).toHaveCount(0);
    await expect(list.paginator).toHaveCount(0);
    await expect(list.unknownHost).toHaveCount(0);
  });
});
