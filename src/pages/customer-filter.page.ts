import { expect, type Locator, type Page, type Response } from '@playwright/test';
import { BasePage } from './base.page';

const FILTER_STORAGE_KEY = 'dispatch.filters';

export type DispatchFilterPage = 'schedule' | 'schedule-comparison' | 'tickets' | 'map' | 'orders' | 'dashboard';

const ROUTES: Record<DispatchFilterPage, string> = {
  schedule: '/#/dispatch/schedule',
  'schedule-comparison': '/#/dispatch/schedule-comparison',
  tickets: '/#/dispatch/tickets',
  map: '/#/dispatch/map',
  orders: '/#/dispatch/orders',
  dashboard: '/#/dashboard/dispatch-dashboard',
};

/**
 * The Customer drop-down on the Dispatch pages (QC-1022): Schedule Board, Plan vs Live, Ticket Activity, Live Map and
 * Dispatch Home through `app-dispatch-filter-bar`, and the Orders filter row. CSS locators are used because the
 * mat-select panel and its search box have no accessible name of their own beyond the field label.
 */
export class DispatchCustomerFilterPage extends BasePage {
  protected readonly path = ROUTES.schedule;

  readonly customerSelect: Locator;
  readonly customerPanel: Locator;
  readonly customerSearch: Locator;
  readonly customerOptions: Locator;
  readonly jobSelect: Locator;
  readonly jobOptions: Locator;
  readonly ticketCards: Locator;

  constructor(page: Page) {
    super(page);
    this.customerSelect = page.locator('app-customer-filter-select mat-select');
    this.customerPanel = page.locator('.customer-filter-panel');
    this.customerSearch = this.customerPanel.locator('.customer-filter-search input');
    this.customerOptions = this.customerPanel.locator('mat-option');
    this.jobSelect = page.locator('mat-form-field.map-filter', { hasText: 'Job' }).locator('mat-select');
    this.jobOptions = page.locator('.mat-mdc-select-panel mat-option');
    this.ticketCards = page.locator('.driver-card');
  }

  async clearSavedFilters(): Promise<void> {
    await this.page.goto(ROUTES.dashboard);
    await this.page.evaluate((key) => localStorage.removeItem(key), FILTER_STORAGE_KEY);
  }

  async open(target: DispatchFilterPage, date?: string): Promise<Response> {
    const list = this.apiResponse('/api/dispatch/customers', (u) => !date || u.searchParams.get('from') === date || target === 'orders');
    await this.page.goto('about:blank');
    await this.page.goto(date ? `${ROUTES[target]}?date=${date}` : ROUTES[target]);
    return list;
  }

  apiResponse(path: string, match: (url: URL) => boolean = () => true, method = 'GET'): Promise<Response> {
    return this.page.waitForResponse((r) => {
      const url = new URL(r.url());
      return url.pathname.toLowerCase().endsWith(path.toLowerCase()) && r.request().method() === method && match(url);
    });
  }

  apiPost(path: string, match: (body: Record<string, unknown> | null) => boolean): Promise<Response> {
    return this.page.waitForResponse((r) => {
      const url = new URL(r.url());
      return url.pathname.toLowerCase().endsWith(path.toLowerCase()) && r.request().method() === 'POST' && match(r.request().postDataJSON());
    });
  }

  async openCustomers(): Promise<void> {
    await this.customerSelect.click();
    await expect(this.customerPanel).toBeVisible();
  }

  async closeCustomers(): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect(this.customerPanel).toBeHidden();
  }

  async customerNames(): Promise<string[]> {
    await this.openCustomers();
    const names = (await this.customerOptions.allInnerTexts()).map((t) => t.trim());
    await this.closeCustomers();
    return names;
  }

  async pickCustomer(name: string): Promise<void> {
    await this.openCustomers();
    await this.customerOption(name).click();
    await expect(this.customerPanel).toBeHidden();
  }

  async clearCustomer(): Promise<void> {
    await this.pickCustomer('All Customers');
  }

  async searchCustomers(text: string): Promise<void> {
    await this.openCustomers();
    await this.customerSearch.fill(text);
  }

  customerOption(name: string): Locator {
    return this.customerOptions.filter({ hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) });
  }

  async expectCustomerShown(name: string): Promise<void> {
    await expect(this.customerSelect).toContainText(name);
  }

  async expectCustomerChip(name: string): Promise<void> {
    await expect(this.page.locator('.board-filter-chip, .filter-chip', { hasText: name })).toBeVisible();
  }

  async setOrdersRange(from: string, to: string): Promise<void> {
    const fromBox = this.page.getByRole('textbox', { name: 'From' });
    const toBox = this.page.getByRole('textbox', { name: 'To' });
    await fromBox.fill(usDate(from));
    await fromBox.press('Enter');
    await toBox.fill(usDate(to));
    await toBox.press('Enter');
  }

  async jobNames(): Promise<string[]> {
    await this.jobSelect.click();
    await expect(this.jobOptions.first()).toBeVisible();
    const names = (await this.jobOptions.allInnerTexts()).map((t) => t.trim());
    await this.page.keyboard.press('Escape');
    await expect(this.jobOptions.first()).toBeHidden();
    return names;
  }

  async pickFirstJob(): Promise<void> {
    await this.jobSelect.click();
    await this.jobOptions.nth(1).click();
    await expect(this.page).toHaveURL(/[?&]job=\d+/);
  }

  async expectUrlCustomer(customerId: number): Promise<void> {
    await expect(this.page).toHaveURL(new RegExp(`[?&]customerId=${customerId}(&|$)`));
  }

  async expectNoJobInUrl(): Promise<void> {
    await expect(this.page).not.toHaveURL(/[?&]job=\d+/);
  }

  async expectTicketCards(count: number): Promise<void> {
    await expect(this.ticketCards).toHaveCount(count);
  }
}

export async function jsonData(response: Response): Promise<unknown> {
  const body = await response.json();
  return body && typeof body === 'object' && 'data' in body ? (body as { data: unknown }).data : body;
}

export function collectNumbers(value: unknown, key: string, found: number[] = []): number[] {
  if (Array.isArray(value)) {
    value.forEach((v) => collectNumbers(v, key, found));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === key && typeof v === 'number') {
        found.push(v);
      } else {
        collectNumbers(v, key, found);
      }
    }
  }
  return found;
}

function usDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return `${m}/${d}/${y}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
