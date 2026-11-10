import { expect, type Locator, type Page, type Response } from '@playwright/test';

export type ResponseAction = 'late' | 'issue' | 'cant-make-it' | 'no-show' | 'noted';

export const TRIP_NOTE_STATUS = { Late: 20, Problem: 30, NoShow: 50 } as const;

export const ASSIGNMENT_STATUS = { Pending: 1, Accepted: 2, Rejected: 3, NoShow: 7 } as const;

export const AI_CLASSIFICATION = { Noted: 40, CantMakeIt: 60 } as const;

export interface OpenAssignment {
  orderAssignmentId: number;
  orderNumber: string | null;
  jobLabel: string | null;
  date: string;
  startTime: string | null;
  status: string;
}

export interface ThreadMessage {
  messageId: number;
  direction: string;
  orderAssignmentId: number | null;
  assignmentStatus: string | null;
  assignmentDate: string | null;
  assignmentStartTime: string | null;
  availableActions: ResponseAction[];
}

export interface LinkThread {
  openAssignments: OpenAssignment[];
  messages: ThreadMessage[];
}

export interface QueueItem {
  messageId: number;
  availableActions: ResponseAction[];
}

export interface UnassignedOrder {
  orderId: number;
  date: string;
  trucksNeeded: number;
  assignedCount: number;
}

export interface ApiAnswer {
  status: number;
  text: string;
  data: unknown;
}

export class MessageLinkPanel {
  constructor(private readonly page: Page) {}

  row(messageId: number): Locator {
    return this.page.locator(`.msg-link[data-message-id="${messageId}"]`);
  }

  linkedTag(messageId: number): Locator {
    return this.row(messageId).locator('.msg-tag--linked');
  }

  unlinkedTag(messageId: number): Locator {
    return this.row(messageId).locator('.msg-tag--unlinked');
  }

  linkMenuButton(messageId: number): Locator {
    return this.row(messageId).locator('button').filter({ hasText: 'Link to assignment' });
  }

  oneTapLinkButton(messageId: number): Locator {
    return this.row(messageId)
      .locator('button')
      .filter({ hasText: /Link to (?!assignment)/ });
  }

  changeButton(messageId: number): Locator {
    return this.row(messageId).locator('button').filter({ hasText: 'Change' });
  }

  menuItems(): Locator {
    return this.page.locator('.mat-mdc-menu-panel .mat-mdc-menu-item');
  }

  menuItem(text: string | RegExp): Locator {
    return this.menuItems().filter({ hasText: text });
  }

  threadActions(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId} button[data-action]`);
  }

  threadAction(messageId: number, action: ResponseAction): Locator {
    return this.page.locator(`#msg-${messageId} button[data-action="${action}"]`);
  }

  queueTab(): Locator {
    return this.page.locator('.queue-tab-btn');
  }

  queueActions(messageId: number): Locator {
    return this.page.locator(`#queue-${messageId} button[data-action]`);
  }

  async actionsOf(buttons: Locator): Promise<string[]> {
    return buttons.evaluateAll((elements) => elements.map((e) => e.getAttribute('data-action') ?? ''));
  }

  async labelsOf(buttons: Locator): Promise<string[]> {
    return (await buttons.allInnerTexts()).map((t) => t.trim());
  }

  waitForLink(messageId: number): Promise<Response> {
    return this.page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/messages/${messageId}/assignment`), {
      timeout: 30_000,
    });
  }

  waitForAction(messageId: number): Promise<Response> {
    return this.page.waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith(`/messages/${messageId}/action`), {
      timeout: 30_000,
    });
  }
}

export function assignmentDateLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export class MessageLinkApi {
  constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  async ready(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }

  async thread(driverUserId: string): Promise<LinkThread> {
    const answer = await this.call('GET', `/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}`);
    expect(answer.status, `GET thread ${driverUserId}`).toBe(200);
    const data = answer.data as LinkThread;
    return { openAssignments: data.openAssignments ?? [], messages: data.messages ?? [] };
  }

  async message(driverUserId: string, messageId: number): Promise<ThreadMessage> {
    const found = (await this.thread(driverUserId)).messages.find((m) => m.messageId === messageId);
    expect(found, `message ${messageId} in the thread`).toBeTruthy();
    return found!;
  }

  async queue(): Promise<QueueItem[]> {
    const answer = await this.call('GET', '/api/dispatch/messages/queue');
    expect(answer.status, 'GET queue').toBe(200);
    return answer.data as QueueItem[];
  }

  async unassigned(date: string, orderId: number): Promise<UnassignedOrder[]> {
    const answer = await this.call('GET', `/api/dispatch/board?from=${date}&orderId=${orderId}`);
    expect(answer.status, 'GET board').toBe(200);
    return ((answer.data as { unassignedOrders?: UnassignedOrder[] }).unassignedOrders ?? []).filter((u) => u.orderId === orderId && u.date === date);
  }

  link(routeMessageId: number, orderAssignmentId: number | null, bodyMessageId = routeMessageId): Promise<ApiAnswer> {
    return this.call('PUT', `/api/dispatch/messages/${routeMessageId}/assignment`, { messageId: bodyMessageId, orderAssignmentId });
  }

  action(routeMessageId: number, classification: ResponseAction, bodyMessageId = routeMessageId): Promise<ApiAnswer> {
    return this.call('PUT', `/api/dispatch/messages/${routeMessageId}/action`, { messageId: bodyMessageId, classification });
  }

  private async call(method: string, path: string, body?: unknown): Promise<ApiAnswer> {
    const { status, text } = await this.page.evaluate(
      async ({ url, method, body }) => {
        const response = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${localStorage.getItem('accessToken')}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      },
      { url: `${this.apiUrl}${path}`, method, body },
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
