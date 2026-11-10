import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { devices, expect, type APIRequestContext, type APIResponse, type Browser, type Locator, type Page } from '@playwright/test';
import { env } from '@config/env.config';
import { IdentityLoginPage } from '@pages/identity-login.page';
import { MailSink, type Email } from '@pages/host-password-link.page';

export const INVITE_SENT = 'Invite sent. The driver is linked once they accept it.';
export const INVITE_NOT_AVAILABLE = 'This invite is not available. It may have expired, been used, or been sent to a different email address.';
export const INVITE_LINK = /http:\/\/localhost:4300\/m\/(i-[A-Za-z0-9_-]+)/;

export type HostInviteStatus = 'pending' | 'accepted' | 'cancelled' | 'expired' | 'revoked';

export interface HostInvite {
  inviteUuid: string;
  invitedEmail: string | null;
  invitedDriverUuid: string | null;
  truckId: number;
  truckName: string | null;
  status: HostInviteStatus;
  expiresAt: string;
  driverUuid: string | null;
  acceptedAt: string | null;
  created: string;
}

export interface DriverInvite {
  inviteUuid: string;
  hostUuid: string;
  hostName: string;
  hostLogoUrl: string | null;
  expiresAt: string;
}

export interface Answer<T = unknown> {
  status: number;
  data: T | null;
  message: string | null;
  errors: string[];
  text: string;
}

async function answer<T>(response: APIResponse): Promise<Answer<T>> {
  const text = await response.text();
  let body: { data?: T; message?: string | null; errors?: string[] } | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status(), data: body?.data ?? null, message: body?.message ?? null, errors: body?.errors ?? [], text };
}

export function inviteTokenHash(code: string): string {
  return createHash('sha256').update(code.replace(/^i-/, ''), 'utf8').digest('hex');
}

export function inviteCode(mail: Email): string {
  const match = INVITE_LINK.exec(mail.text);
  if (!match) throw new Error(`No invite link in ${mail.file}.`);
  return match[1];
}

export async function waitForInviteEmail(address: string, since: Set<string>, timeout = 30_000): Promise<Email> {
  let found: Email | undefined;
  await expect
    .poll(
      () => {
        found = MailSink.newTo(address, since).find((mail) => INVITE_LINK.test(mail.text));
        return found !== undefined;
      },
      { message: `an invite email reaches ${address} in the SMTP sink`, timeout, intervals: [500, 1_000, 2_000] },
    )
    .toBe(true);
  return found!;
}

export class HostDriverInvitesApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password } });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  async list(): Promise<Answer<HostInvite[]>> {
    return answer(await this.request.get(`${hostApiUrl()}/api/driver-invites`, { headers: this.headers() }));
  }

  async find(inviteUuid: string): Promise<HostInvite | undefined> {
    return (await this.list()).data?.find((invite) => invite.inviteUuid === inviteUuid);
  }

  async send(data: { invitedEmail?: string; invitedDriverUuid?: string; truckId: number }): Promise<Answer<HostInvite>> {
    return answer(await this.request.post(`${hostApiUrl()}/api/driver-invites`, { headers: this.headers(), data }));
  }

  async resend(inviteUuid: string): Promise<Answer<HostInvite>> {
    return answer(await this.request.post(`${hostApiUrl()}/api/driver-invites/${inviteUuid}/resend`, { headers: this.headers() }));
  }

  async cancel(inviteUuid: string): Promise<Answer> {
    return answer(await this.request.delete(`${hostApiUrl()}/api/driver-invites/${inviteUuid}`, { headers: this.headers() }));
  }

  async revoke(inviteUuid: string): Promise<Answer> {
    return answer(await this.request.post(`${hostApiUrl()}/api/driver-invites/${inviteUuid}/revoke`, { headers: this.headers() }));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

export class DriverInvitesApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  async list(): Promise<Answer<{ invites: DriverInvite[] }>> {
    return answer(await this.request.get(`${driversApiUrl()}/invites`, { headers: this.headers() }));
  }

  async listedUuids(): Promise<string[]> {
    return ((await this.list()).data?.invites ?? []).map((invite) => invite.inviteUuid.toLowerCase());
  }

  async accept(inviteUuid: string): Promise<Answer<{ hostUuid: string; name: string; logoUrl: string | null }>> {
    return answer(await this.request.post(`${driversApiUrl()}/invites/${inviteUuid}/accept`, { headers: this.headers() }));
  }

  async acceptCode(code: string): Promise<Answer<{ hostUuid: string; name: string; logoUrl: string | null }>> {
    return answer(await this.request.post(`${driversApiUrl()}/invites/accept`, { headers: this.headers(), data: { code } }));
  }

  async decline(inviteUuid: string): Promise<Answer> {
    return answer(await this.request.post(`${driversApiUrl()}/invites/${inviteUuid}/decline`, { headers: this.headers() }));
  }

  async leaveHost(hostUuid: string): Promise<Answer> {
    return answer(await this.request.delete(`${driversApiUrl()}/me/hosts/${hostUuid}`, { headers: this.headers() }));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

export const QC774_VENDOR_STATE = path.join('.auth', env.name, 'qc774-app-vendor.json');

export class DriverInvitesPage {
  readonly inviteBy: Locator;
  readonly email: Locator;
  readonly driverId: Locator;
  readonly truck: Locator;
  readonly send: Locator;
  readonly table: Locator;
  readonly empty: Locator;
  readonly unavailable: Locator;
  readonly sidebarLink: Locator;

  constructor(private readonly page: Page) {
    this.inviteBy = page.getByTestId('invite-by');
    this.email = page.getByTestId('invite-email');
    this.driverId = page.getByTestId('invite-driver-id');
    this.truck = page.getByTestId('invite-truck');
    this.send = page.getByTestId('invite-send');
    this.table = page.getByTestId('invites-table');
    this.empty = page.getByTestId('invites-empty');
    this.unavailable = page.getByTestId('invites-unavailable');
    this.sidebarLink = page.locator('a[href*="vendor-driver-invites"]');
  }

  async open(): Promise<void> {
    await this.page.goto('/#/vendors/vendor-driver-invites');
    await expect(this.table.or(this.empty).or(this.unavailable).first()).toBeVisible({ timeout: 30_000 });
  }

  async chooseInviteBy(label: 'By email' | 'By driver ID'): Promise<void> {
    await this.inviteBy
      .getByRole('radio', { name: label })
      .or(this.inviteBy.getByRole('button', { name: label }))
      .first()
      .click();
  }

  async chooseTruck(name: string): Promise<void> {
    await this.truck.click();
    await this.page.getByRole('option', { name }).click();
  }

  row(inviteUuid: string): Locator {
    return this.page.getByTestId(`invite-row-${inviteUuid}`);
  }

  status(inviteUuid: string): Locator {
    return this.page.getByTestId(`invite-status-${inviteUuid}`);
  }

  static async signIn(browser: Browser, email: string, password: string, authenticatorKey: string): Promise<void> {
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      userAgent: devices['Desktop Chrome'].userAgent,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/authentication');
      await new IdentityLoginPage(page).signInWithTwoStep({ email, password }, authenticatorKey);
      await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
      fs.mkdirSync(path.dirname(QC774_VENDOR_STATE), { recursive: true });
      await context.storageState({ path: QC774_VENDOR_STATE });
    } finally {
      await context.close();
    }
  }
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}

function driversApiUrl(): string {
  if (!env.driversApiUrl) throw new Error('DRIVERS_API_URL is not set.');
  return env.driversApiUrl;
}
