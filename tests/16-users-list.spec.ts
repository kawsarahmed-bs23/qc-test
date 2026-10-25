import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { PLATFORM_ADMIN_EMAIL } from '../fixtures/throwawayUsers';
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

  test.beforeAll(() => {
    runIdentitySeedScript('identity-qc742-users.apply.sql');
  });

  test.afterAll(() => {
    runIdentitySeedScript('identity-qc742.remove.sql');
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

  test('USRLIST-03 there is no host or role filter any more, and the columns are name, email, platform admin, last sign-in and account (QC-775)', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await expect(page.locator('#user-host')).toHaveCount(0);
    await expect(page.locator('#user-role')).toHaveCount(0);
    await expect(list.table.locator('th')).toHaveText([/Name/, /Email/, /Platform admin/, /Last sign-in|Last login/, /Account/]);
  });

  test('USRLIST-04 the platform admin column marks a HOST_MASTER platform admin and nobody else (QC-775)', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: PLATFORM_ADMIN_EMAIL });
    await expect(list.cell(list.rowByEmail(PLATFORM_ADMIN_EMAIL), 'user-platform-admin')).toHaveText('Admin');

    await list.open({ search: SEARCH, pageSize: 50 });
    await expect(list.rows).toHaveCount(40);
    await expect(list.table.locator('[data-testid="user-platform-admin"]')).toHaveCount(0);
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

  test('USRLIST-06 search and status combine', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.searchFor(SEARCH);
    await list.chooseStatus('Deactivated');
    expect(Object.fromEntries(list.query())).toEqual({ search: SEARCH, status: 'deactivated' });

    const expected = emails(`${SEEDED} AND u.IsActive = 0`);
    expect(await list.emails()).toEqual(expected);
    expect(expected).toEqual([7, 14, 21, 28, 35].map(seeded));
  });

  test('USRLIST-07 filters survive paging with 15 users a page, and the pages hold every match exactly once', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, status: 'active' });
    const expected = emails(`${SEEDED} AND u.IsActive = 1`).slice(0, 30);
    expect(expected.length).toBeGreaterThan(15);

    await list.setPageSize(15);
    await list.waitForQuery((q) => q.get('pageSize') === '15');
    await expect(list.rows).toHaveCount(15);
    const first = await list.emails();

    await list.nextPage();
    await list.waitForQuery((q) => q.get('page') === '2');
    expect(Object.fromEntries(list.query())).toEqual({ search: SEARCH, status: 'active', page: '2', pageSize: '15' });
    await expect(list.selected(list.status)).toHaveText('Active');
    await expect(list.search).toHaveValue(SEARCH);
    const second = await list.emails();
    for (const row of await list.rows.all()) {
      await expect(list.cell(row, 'user-account')).toHaveText('Active');
    }

    expect([...first, ...second]).toEqual(expected);
    expect(await totalOf(list)).toBe(count(`${SEEDED} AND u.IsActive = 1`));
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

  test('USRLIST-11 the URL and every link carry only GUIDs, never a numeric id', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH });
    for (const [key, value] of list.query()) {
      expect(value, key).not.toMatch(/^\d+$/);
    }
    for (const id of await list.userIds()) {
      expect(id).toMatch(GUID);
    }
    for (const href of await list.rows.locator('a').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''))) {
      expect(href).toMatch(/^#\/users\/[0-9a-f-]{36}$/i);
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

  test('USRLIST-13 Reset filters clears search, status, sort and paging', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: SEARCH, status: 'active', sort: 'name', dir: 'desc', page: 2, pageSize: 15 });
    await expect(list.selected(list.status)).toHaveText('Active');

    await list.reset.click();
    await list.waitForQuery((q) => q.toString() === '');
    await expect(page).toHaveURL(adminUrl('/users'));
    await expect(list.search).toHaveValue('');
    await expect(list.selected(list.status)).toHaveText('All accounts');
    expect(await totalOf(list)).toBe(count('1 = 1'));
  });

  test('USRLIST-14 a host or role left in an old link is ignored and every account is listed (QC-775)', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ host: '00000000-0000-0000-0000-000000000001', role: 'Driver' });
    await expect(page.locator('#users-unknown-host')).toHaveCount(0);
    expect(await totalOf(list)).toBe(count('1 = 1'));
  });

  test('USRLIST-15 a search that matches nobody shows the empty state and no pager', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open();
    await list.searchFor('zz-no-such-user-zz');
    await expect(list.empty).toHaveText('No users match these filters.');
    await expect(list.rows).toHaveCount(0);
    await expect(list.paginator).toHaveCount(0);
  });
});
