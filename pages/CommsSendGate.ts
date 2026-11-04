import * as fs from 'fs';
import * as path from 'path';
import { devices, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '../fixtures/localDb';
import { newAuthenticatorKey } from '../fixtures/totp';
import { IdentityLoginPage } from './IdentityLoginPage';

export const MESSAGE_CHANNEL = { Sms: 10, InApp: 20, Link: 30 } as const;

export const API_CHANNEL = { Sms: 'sms', InApp: 'in-app', Link: 'link' } as const;

export type ApiChannel = (typeof API_CHANNEL)[keyof typeof API_CHANNEL];

export interface CommsThreadGate {
  canSend: boolean;
  cannotSendReason: string | null;
  canSendSms: boolean;
  canSendInApp: boolean;
  canStatusPing: boolean;
  activeOrderAssignmentId: number | null;
}

export interface CommsApiAnswer {
  status: number;
  text: string;
  messageId: number | null;
  orderAssignmentId: number | null;
}

export class CommsComposer {
  constructor(private readonly page: Page) {}

  input(): Locator {
    return this.page.locator('.thread-reply .reply-input');
  }

  hint(): Locator {
    return this.page.locator('.thread-reply .reply-hint');
  }

  blockedHint(): Locator {
    return this.page.locator('.thread-reply .reply-hint.reply-hint--blocked');
  }

  sendButton(): Locator {
    return this.page.locator('.thread-reply button').filter({ hasText: 'Send' });
  }

  toggle(label: 'SMS' | 'In-app'): Locator {
    return this.page.locator('.thread-reply .channel-toggle mat-button-toggle').filter({ hasText: label });
  }

  toggleButton(label: 'SMS' | 'In-app'): Locator {
    return this.toggle(label).locator('button');
  }

  pingMain(): Locator {
    return this.page.locator('.ping-split__main');
  }

  pingCaret(): Locator {
    return this.page.locator('.ping-split__caret');
  }

  pingMenuItem(text: string): Locator {
    return this.page.locator('.mat-mdc-menu-panel .mat-mdc-menu-item').filter({ hasText: text });
  }

  sentText(body: string): Locator {
    return this.page.locator('.msg-text', { hasText: body });
  }

  async send(body: string, channel: 'SMS' | 'In-app'): Promise<void> {
    await this.toggle(channel).click();
    await expect(this.toggle(channel)).toHaveClass(/mat-button-toggle-checked/);
    await this.input().fill(body);
    await this.sendButton().click();
  }
}

export class CommsApi {
  constructor(
    private readonly page: Page,
    private readonly apiUrl: string,
  ) {}

  async ready(): Promise<void> {
    await expect.poll(() => this.page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
  }

  async thread(driverUserId: string, date?: string): Promise<CommsThreadGate> {
    const answer = await this.call('GET', `/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}${date ? `?date=${date}` : ''}`);
    expect(answer.status, `GET thread ${driverUserId}`).toBe(200);
    const data = JSON.parse(answer.text).data;
    return {
      canSend: data.canSend,
      cannotSendReason: data.cannotSendReason ?? null,
      canSendSms: data.canSendSms,
      canSendInApp: data.canSendInApp,
      canStatusPing: data.canStatusPing,
      activeOrderAssignmentId: data.activeOrderAssignmentId ?? null,
    };
  }

  send(driverUserId: string, messageBody: string, channel: ApiChannel): Promise<CommsApiAnswer> {
    return this.call('POST', '/api/dispatch/messages/send', { driverUserId, orderAssignmentId: null, messageBody, channel });
  }

  ping(driverUserId: string, channel: ApiChannel): Promise<CommsApiAnswer> {
    return this.call('POST', `/api/dispatch/drivers/${encodeURIComponent(driverUserId)}/ping?channel=${channel}`, {});
  }

  private async call(method: string, path: string, body?: unknown): Promise<CommsApiAnswer> {
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

    let data: { messageId?: number; orderAssignmentId?: number } | null = null;
    let decoded = text;
    try {
      const parsed = JSON.parse(text);
      decoded = JSON.stringify(parsed);
      data = parsed?.data ?? null;
    } catch {
      data = null;
    }
    return {
      status,
      text: decoded,
      messageId: typeof data?.messageId === 'number' ? data.messageId : null,
      orderAssignmentId: typeof data?.orderAssignmentId === 'number' ? data.orderAssignmentId : null,
    };
  }
}

export const QC804_ADMIN_EMAIL = 'e2e.qc804.commsadmin@quarryconnect.test';
export const QC804_ADMIN_STATE = path.join('.auth', env.name, 'qc804-app-admin.json');

export class CommsHostAdmin {
  static async signIn(browser: Browser, statePath: string = QC804_ADMIN_STATE): Promise<void> {
    if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway host admin copies that password.');
    const authenticatorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc804-user.apply.sql', {
      Email: QC804_ADMIN_EMAIL,
      SourceEmail: env.admin.email,
      LastName: 'QC-804 Comms admin',
      TwoFactor: '1',
      AuthenticatorKey: authenticatorKey,
    });
    const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(N'${QC804_ADMIN_EMAIL}')`);
    if (!userId) throw new Error(`The throwaway user ${QC804_ADMIN_EMAIL} was not created.`);
    runSeedScript('host-qc804-admin.apply.sql', { UserId: userId, Email: QC804_ADMIN_EMAIL });

    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/authentication');
      await new IdentityLoginPage(page).signInWithTwoStep({ email: QC804_ADMIN_EMAIL, password: env.admin.password }, authenticatorKey);
      await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
      await expect.poll(() => page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('companySettings') ?? 'null')?.features?.dispatch === true;
        } catch {
          return false;
        }
      }), { message: 'the host settings with the dispatch feature are cached', timeout: 30_000 }).toBe(true);
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      await context.storageState({ path: statePath });
    } finally {
      await context.close();
    }
  }

  static remove(statePath: string = QC804_ADMIN_STATE): void {
    runSeedScript('host-qc804.remove.sql');
    runIdentitySeedScript('identity-qc804.remove.sql', { EmailLike: 'e2e.qc804.%@quarryconnect.test' });
    fs.rmSync(statePath, { force: true });
  }
}
