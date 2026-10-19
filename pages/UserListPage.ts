import { expect, type Locator, type Page } from '@playwright/test';
import { openAdmin, waitForIdle } from './AdminShell';
import { chooseOption, selectedText } from './HostManagementPages';

export type UserSortColumn = 'name' | 'email' | 'lastLogin';

export class UserListPage {
  readonly card: Locator;
  readonly reset: Locator;
  readonly search: Locator;
  readonly host: Locator;
  readonly role: Locator;
  readonly status: Locator;
  readonly table: Locator;
  readonly rows: Locator;
  readonly paginator: Locator;
  readonly empty: Locator;
  readonly unknownHost: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.card = page.locator('#users-card');
    this.reset = page.locator('#users-reset');
    this.search = page.locator('#user-search');
    this.host = page.locator('#user-host');
    this.role = page.locator('#user-role');
    this.status = page.locator('#user-status');
    this.table = page.locator('#users-table');
    this.rows = page.locator('#users-table tr[data-user-id]');
    this.paginator = page.locator('[data-testid="table-paginator"]');
    this.empty = page.locator('[data-testid="table-empty"]');
    this.unknownHost = page.locator('#users-unknown-host');
    this.error = page.locator('#users-error');
  }

  async open(query: Record<string, string | number> = {}): Promise<void> {
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    await openAdmin(this.page, `/users${params.toString() ? `?${params}` : ''}`);
    await this.settled();
  }

  async settled(): Promise<void> {
    await expect(this.card).toBeVisible();
    await waitForIdle(this.page);
    await expect(this.rows.first().or(this.empty).or(this.error)).toBeVisible();
  }

  row(userId: string): Locator {
    return this.page.locator(`#users-table tr[data-user-id="${userId}" i]`);
  }

  rowByEmail(email: string): Locator {
    return this.rows.filter({ has: this.page.locator('[data-testid="user-email"]', { hasText: email }) });
  }

  cell(row: Locator, name: 'user-name' | 'user-email' | 'user-roles' | 'user-hosts' | 'user-last-login' | 'user-account'): Locator {
    return row.locator(`[data-testid="${name}"]`);
  }

  async emails(): Promise<string[]> {
    return (await this.rows.locator('[data-testid="user-email"]').allInnerTexts()).map((text) => text.trim());
  }

  async userIds(): Promise<string[]> {
    return this.rows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-user-id')!));
  }

  async waitForQuery(predicate: (params: URLSearchParams) => boolean): Promise<void> {
    await expect.poll(() => predicate(this.query()), { message: `URL query: ${this.page.url()}` }).toBe(true);
    await this.settled();
  }

  query(): URLSearchParams {
    const hash = new URL(this.page.url()).hash;
    const index = hash.indexOf('?');
    return new URLSearchParams(index >= 0 ? hash.substring(index + 1) : '');
  }

  async searchFor(text: string): Promise<void> {
    await this.search.fill(text);
    await this.waitForQuery((q) => (q.get('search') ?? '') === text.trim());
  }

  async chooseHost(name: string | RegExp): Promise<void> {
    await chooseOption(this.page, this.host, name);
    await this.settled();
  }

  async chooseRole(role: 'Admin' | 'Driver' | 'HostUser' | 'All roles'): Promise<void> {
    await chooseOption(this.page, this.role, new RegExp(`^\\s*${role}\\s*$`));
    await this.settled();
  }

  async chooseStatus(label: 'All accounts' | 'Active' | 'Deactivated'): Promise<void> {
    await chooseOption(this.page, this.status, new RegExp(`^\\s*${label}\\s*$`));
    await this.settled();
  }

  selected(select: Locator): Locator {
    return selectedText(select);
  }

  sortHeader(column: UserSortColumn): Locator {
    return this.page.locator(`#users-table th.mat-column-${column} .mat-sort-header-container`);
  }

  async sortBy(column: UserSortColumn, dir: 'asc' | 'desc'): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const q = this.query();
      const currentSort = q.get('sort') ?? 'email';
      const currentDir = q.get('dir') ?? 'asc';
      if (currentSort === column && currentDir === dir) {
        break;
      }
      await this.sortHeader(column).click();
      await this.waitForQuery((next) => next.toString() !== q.toString());
    }
    await this.settled();
  }

  async setPageSize(size: number): Promise<void> {
    await chooseOption(this.page, this.paginator.locator('.mat-mdc-paginator-touch-target'), new RegExp(`^\\s*${size}\\s*$`));
    await this.settled();
  }

  get rangeLabel(): Locator {
    return this.paginator.locator('.mat-mdc-paginator-range-label');
  }

  async nextPage(): Promise<void> {
    await this.paginator.locator('button.mat-mdc-paginator-navigation-next').click();
    await this.settled();
  }

  async lastPage(): Promise<void> {
    await this.paginator.locator('button.mat-mdc-paginator-navigation-last').click();
    await this.settled();
  }
}
