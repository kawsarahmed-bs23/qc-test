import { expect, type Locator, type Page, type Response } from '@playwright/test';

export interface DayThreadSummary {
  driverUserId: string;
  driverName: string | null;
  unreadCount: number;
  lastMessageBody: string | null;
  lastMessageAt: string | null;
}

export interface DayAssignment {
  orderAssignmentId: number;
  orderNumber: string | null;
  jobLabel: string | null;
  date: string;
  startTime: string | null;
  status: string;
}

export interface DayThread {
  driverName: string | null;
  assignments: DayAssignment[];
  openAssignments: DayAssignment[];
  hasEarlierMessages: boolean;
  messages: { messageId: number; messageBody: string | null }[];
}

export interface EarlierPage {
  messages: { messageId: number; messageBody: string | null }[];
  hasMore: boolean;
}

export interface DayApiAnswer {
  status: number;
  text: string;
  data: unknown;
}

export class CommsDayPage {
  constructor(private readonly page: Page) {}

  async open(query: { date?: string; driverId?: string }): Promise<void> {
    const params = new URLSearchParams();
    if (query.driverId) params.set('driverId', query.driverId);
    if (query.date) params.set('date', query.date);
    const search = params.toString();
    if (this.page.url().startsWith('http')) await this.page.goto('about:blank');
    await this.page.goto(`/#/dispatch/comms${search ? `?${search}` : ''}`);
  }

  waitForThreads(date: string): Promise<Response> {
    return this.page.waitForResponse((r) => r.request().method() === 'GET'
      && new URL(r.url()).pathname.endsWith('/messages/threads')
      && new URL(r.url()).searchParams.get('date') === date, { timeout: 30_000 });
  }

  waitForThread(driverUserId: string, date: string): Promise<Response> {
    return this.page.waitForResponse((r) => r.request().method() === 'GET'
      && new URL(r.url()).pathname.endsWith(`/messages/threads/${driverUserId}`)
      && new URL(r.url()).searchParams.get('date') === date, { timeout: 30_000 });
  }

  waitForEarlier(driverUserId: string): Promise<Response> {
    return this.page.waitForResponse((r) => r.request().method() === 'GET'
      && new URL(r.url()).pathname.endsWith(`/messages/threads/${driverUserId}/earlier`), { timeout: 30_000 });
  }

  driverItems(): Locator {
    return this.page.locator('.driver-item:not(.driver-item--empty)');
  }

  driverItem(name: string): Locator {
    return this.driverItems().filter({
      has: this.page.locator('.driver-item-name', { hasText: new RegExp(`^\\s*${escapeRegExp(name)}\\s*$`) }),
    });
  }

  async driverNames(): Promise<string[]> {
    return (await this.driverItems().locator('.driver-item-name').allInnerTexts()).map((t) => t.trim());
  }

  preview(name: string): Locator {
    return this.driverItem(name).locator('.preview-text');
  }

  listEmpty(): Locator {
    return this.page.locator('.driver-item--empty .preview-text');
  }

  threadEmpty(): Locator {
    return this.page.locator('.thread-empty .preview-text');
  }

  newMessageButton(): Locator {
    return this.page.locator('[data-testid="new-message"]');
  }

  newMessageSearch(): Locator {
    return this.page.locator('[data-testid="new-message-search"]');
  }

  newMessageOption(text: string): Locator {
    return this.page.locator('mat-option').filter({ hasText: text });
  }

  newMessageOpen(): Locator {
    return this.page.locator('[data-testid="new-message-open"]');
  }

  threadScroll(): Locator {
    return this.page.locator('.thread-messages');
  }

  threadRows(): Locator {
    return this.threadScroll().locator('.msg-row');
  }

  message(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId}`);
  }

  loadEarlier(): Locator {
    return this.page.locator('[data-testid="load-earlier"]');
  }

  threadStart(): Locator {
    return this.page.locator('[data-testid="thread-start"]');
  }

  dayDivider(): Locator {
    return this.page.locator('[data-testid="thread-day-divider"]');
  }

  assignmentsTitle(): Locator {
    return this.page.locator('[data-testid="assignments-title"]');
  }

  assignmentRows(): Locator {
    return this.page.locator('[data-testid="assignment-row"]');
  }

  async threadMessageIds(): Promise<number[]> {
    return this.threadRows().evaluateAll((rows) => rows.map((r) => Number(r.id.replace('msg-', ''))));
  }

  async scrollState(): Promise<{ top: number; height: number; client: number }> {
    return this.threadScroll().evaluate((el) => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight }));
  }

  async scrollToTop(): Promise<void> {
    await this.threadScroll().evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
  }

  async offsetInThread(messageId: number): Promise<number> {
    return this.message(messageId).evaluate((row) => {
      const container = row.closest('.thread-messages')!;
      return row.getBoundingClientRect().top - container.getBoundingClientRect().top;
    });
  }

  async isInsideThreadView(messageId: number): Promise<boolean> {
    return this.message(messageId).evaluate((row) => {
      const container = row.closest('.thread-messages')!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return box.bottom <= container.bottom + 1 && box.top >= container.top - 1;
    });
  }
}

export class CommsDayApi {
  constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  async ready(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }

  async threads(date?: string): Promise<DayThreadSummary[]> {
    const answer = await this.call(`/api/dispatch/messages/threads${date ? `?date=${date}` : ''}`);
    expect(answer.status, `GET threads ${date ?? ''}`).toBe(200);
    return answer.data as DayThreadSummary[];
  }

  async thread(driverUserId: string, date?: string): Promise<DayThread> {
    const answer = await this.call(`/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}${date ? `?date=${date}` : ''}`);
    expect(answer.status, `GET thread ${driverUserId}`).toBe(200);
    return answer.data as DayThread;
  }

  earlier(driverUserId: string, query: { date?: string; before?: number; take?: number }): Promise<DayApiAnswer> {
    const params = new URLSearchParams();
    if (query.date) params.set('date', query.date);
    if (query.before !== undefined) params.set('before', String(query.before));
    if (query.take !== undefined) params.set('take', String(query.take));
    return this.call(`/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}/earlier?${params}`);
  }

  private async call(path: string): Promise<DayApiAnswer> {
    const { status, text } = await this.page.evaluate(
      async (url) => {
        const response = await fetch(url, { headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}` } });
        return { status: response.status, text: await response.text() };
      },
      `${this.apiUrl}${path}`,
    );

    let data: unknown = null;
    try {
      const parsed = JSON.parse(text);
      data = parsed?.data ?? parsed;
    } catch {
      data = null;
    }
    return { status, text, data };
  }
}

export function dayLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export function isoToLocalDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
