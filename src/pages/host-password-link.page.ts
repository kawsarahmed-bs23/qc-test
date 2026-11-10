import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env, ROOT_DIR } from '@config/env.config';
import { querySingleValue, runSeedScript } from '@utils/localDb';
import { QC804_ADMIN_STATE } from '@pages/comms-send-gate.page';

export const QC800_DOMAIN = 'example.com';

export function qc800Email(name: string): string {
  return `e2e.qc800.${name}@${QC800_DOMAIN}`;
}

export const RESET_EMAIL_SENT = 'Password reset email sent.';
export const INVALID_RESET = 'Invalid reset token or email';
export const LINK_USED = 'This link has expired or has already been used.';
export const FORGOT_TOAST = 'If an account exists for that address, we have emailed a link to set a new password.';
export const PASSWORD_SET = 'Your password is set. Sign in with it now.';
export const PASSWORD_LIMIT_PER_MINUTE = 5;

export const MAIL_DIR = path.join(ROOT_DIR, 'reports', 'local', 'mail');

export interface Email {
  file: string;
  headers: Map<string, string>;
  text: string;
}

export interface PasswordLinkUrl {
  raw: string;
  email: string;
  code: string;
}

export interface ApiAnswer {
  status: number;
  body: { data?: unknown; message?: string | null; errors?: string[]; validationErrors?: Record<string, string[]> } | null;
  text: string;
  retryAfter: string | null;
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const soft = value.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    const hex = soft.slice(i + 1, i + 3);
    if (soft[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(soft[i], 'utf8'));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function splitHeaders(raw: string): { headers: Map<string, string>; body: string } {
  const separator = raw.search(/\r?\n\r?\n/);
  const head = separator < 0 ? raw : raw.slice(0, separator);
  const body = separator < 0 ? '' : raw.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodePart(raw: string): string {
  const { headers, body } = splitHeaders(raw);
  const type = headers.get('content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    return body
      .split(`--${boundary}`)
      .filter((part) => part.trim() && !part.startsWith('--'))
      .map((part) => decodePart(part.replace(/^\r?\n/, '')))
      .join('\n');
  }
  const encoding = (headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return body;
}

export function readEmail(file: string): Email {
  const raw = fs.readFileSync(file, 'utf8');
  return { file, headers: splitHeaders(raw).headers, text: decodePart(raw) };
}

export class MailSink {
  static isListening(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port: 2525 });
      socket.setTimeout(2_000);
      socket.once('data', (chunk) => {
        socket.end('QUIT\r\n');
        resolve(chunk.toString().startsWith('220'));
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  static mark(): Set<string> {
    return new Set(fs.existsSync(MAIL_DIR) ? fs.readdirSync(MAIL_DIR) : []);
  }

  static newTo(address: string, since: Set<string>): Email[] {
    if (!fs.existsSync(MAIL_DIR)) return [];
    return fs
      .readdirSync(MAIL_DIR)
      .filter((name) => name.endsWith('.eml') && !since.has(name))
      .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || a.localeCompare(b))
      .map((name) => readEmail(path.join(MAIL_DIR, name)))
      .filter((mail) => (mail.headers.get('to') ?? '').toLowerCase().includes(address.toLowerCase()));
  }

  static async latestTo(address: string, since: Set<string>): Promise<Email> {
    let found: Email | undefined;
    await expect
      .poll(() => (found = MailSink.newTo(address, since).at(-1)) !== undefined, { message: `an email to ${address} reaches the SMTP sink`, timeout: 20_000 })
      .toBe(true);
    return found!;
  }
}

export function passwordLinkIn(mail: Email): PasswordLinkUrl {
  const match =
    /href="([^"]*\/authentication\/reset-password\?[^"]+)"/i.exec(mail.text) ?? /(https?:\/\/\S+\/authentication\/reset-password\?[^\s"<]+)/i.exec(mail.text);
  expect(match, `a reset-password link in ${mail.file}`).not.toBeNull();
  const raw = match![1].replace(/&amp;/g, '&');
  const url = new URL(raw);
  return { raw, email: url.searchParams.get('email') ?? '', code: url.searchParams.get('code') ?? '' };
}

export function appLinkFor(link: PasswordLinkUrl): string {
  const url = new URL(link.raw);
  return `${env.appUrl}/#${url.pathname}${url.search}`;
}

export function tamper(code: string): string {
  const middle = Math.floor(code.length / 2);
  const swapped = code[middle] === 'A' ? 'B' : 'A';
  return code.slice(0, middle) + swapped + code.slice(middle + 1);
}

const passwordCalls: number[] = [];

export const PasswordRequestPacer = {
  windowMs: 62_000,

  async waitForSlot(slots = 1): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (passwordCalls.length && now - passwordCalls[0] > this.windowMs) passwordCalls.shift();
      if (passwordCalls.length + slots <= PASSWORD_LIMIT_PER_MINUTE) return;
      await new Promise((resolve) => setTimeout(resolve, passwordCalls[0] + this.windowMs - now + 250));
    }
  },

  async waitForEmptyWindow(): Promise<void> {
    await this.waitForSlot(PASSWORD_LIMIT_PER_MINUTE);
  },

  note(): void {
    passwordCalls.push(Date.now());
  },

  async waitOut(retryAfterSeconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, (retryAfterSeconds + 1) * 1000));
    passwordCalls.length = 0;
  },
};

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}

async function answer(response: Awaited<ReturnType<APIRequestContext['post']>>): Promise<ApiAnswer> {
  const text = await response.text();
  let body: ApiAnswer['body'] = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status(), body, text, retryAfter: response.headers()['retry-after'] ?? null };
}

export class HostPasswordApi {
  private constructor(private readonly api: APIRequestContext) {}

  static async open(): Promise<HostPasswordApi> {
    return new HostPasswordApi(await request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  close(): Promise<void> {
    return this.api.dispose();
  }

  async forgot(email: string, paced = true): Promise<ApiAnswer> {
    return this.send(paced, () => this.api.post(`${hostApiUrl()}/api/account/forgotpassword`, { data: { email } }));
  }

  async reset(email: string, code: string, password: string, paced = true): Promise<ApiAnswer> {
    return this.send(paced, () => this.api.post(`${hostApiUrl()}/api/manage/resetpassword`, { data: { email, code, password, confirmPassword: password } }));
  }

  private async send(paced: boolean, call: () => ReturnType<APIRequestContext['post']>): Promise<ApiAnswer> {
    if (!paced) {
      PasswordRequestPacer.note();
      return answer(await call());
    }
    await PasswordRequestPacer.waitForSlot();
    PasswordRequestPacer.note();
    const first = await answer(await call());
    if (first.status !== 429) return first;
    await PasswordRequestPacer.waitOut(Number(first.retryAfter ?? '60'));
    PasswordRequestPacer.note();
    return answer(await call());
  }

  async login(email: string, password: string): Promise<number> {
    const response = await this.api.post(`${hostApiUrl()}/api/account/login`, { data: { email, password } });
    return response.status();
  }
}

export interface NewHostUser {
  userName: string;
  firstName: string;
  lastName: string;
  password: string;
  isActive: boolean;
}

export class HostUserAdminApi {
  private constructor(private readonly api: APIRequestContext) {}

  static async open(statePath: string = QC804_ADMIN_STATE): Promise<HostUserAdminApi> {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { origins: { origin: string; localStorage: { name: string; value: string }[] }[] };
    const token = state.origins.flatMap((origin) => origin.localStorage).find((item) => item.name === 'accessToken')?.value;
    if (!token) throw new Error(`No accessToken in ${statePath}.`);
    return new HostUserAdminApi(await request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, extraHTTPHeaders: { Authorization: `Bearer ${token}` } }));
  }

  close(): Promise<void> {
    return this.api.dispose();
  }

  async create(user: NewHostUser): Promise<ApiAnswer> {
    return answer(
      await this.api.post(`${hostApiUrl()}/api/manageusers/user-create`, {
        data: {
          userName: user.userName,
          firstName: user.firstName,
          lastName: user.lastName,
          phoneNumber: '',
          password: user.password,
          confirmPassword: user.password,
          role: 'Sales',
          isActive: user.isActive,
          organisationId: 0,
          organisationLocationId: 0,
          canSetOrganisation: false,
          isBillingContact: false,
        },
      }),
    );
  }
}

export interface HostUserPassword {
  passwordHash: string | null;
  securityStamp: string | null;
}

function sqlEmail(email: string): string {
  if (!/^e2e\.qc800\.[a-z0-9-]+@example\.com$/.test(email)) throw new Error(`${email} is not a QC-800 throwaway address.`);
  return `N'${email.toUpperCase()}'`;
}

export const Qc800HostUsers = {
  password(email: string): HostUserPassword {
    const row = querySingleValue(`SELECT CONCAT(ISNULL(PasswordHash, 'NULL'), '|', SecurityStamp) FROM auth.Users WHERE NormalizedEmail = ${sqlEmail(email)}`);
    if (!row) throw new Error(`The host user ${email} is missing.`);
    const [passwordHash, securityStamp] = row.split('|');
    return { passwordHash: passwordHash === 'NULL' ? null : passwordHash, securityStamp };
  },

  lockout(email: string): string {
    return (
      querySingleValue(
        `SELECT CONCAT(AccessFailedCount, '|', CASE WHEN LockoutEnd > SYSDATETIMEOFFSET() THEN 1 ELSE 0 END) FROM auth.Users WHERE NormalizedEmail = ${sqlEmail(email)}`,
      ) ?? ''
    );
  },

  lockOut(email: string): void {
    querySingleValue(
      `UPDATE auth.Users SET AccessFailedCount = 3, LockoutEnd = DATEADD(hour, 1, SYSDATETIMEOFFSET()) WHERE NormalizedEmail = ${sqlEmail(email)}`,
    );
  },

  latestNotification(email: string, messageTypeName: string): { messageBody: string | null; bcc: string | null } {
    const row = querySingleValue(
      `SELECT TOP 1 CONCAT(CASE WHEN MessageBody IS NULL THEN 'NULL' WHEN MessageBody = N'' THEN 'EMPTY' ELSE 'TEXT' END, '|', ISNULL(NotificationBcc, 'NULL'))
       FROM auth.SystemNotifications WHERE NotifcationTo = N'${email}' AND MessageTypeName = N'${messageTypeName}' ORDER BY SystemNotificationId DESC`,
    );
    if (!row) throw new Error(`No ${messageTypeName} notification for ${email}.`);
    const [body, bcc] = row.split('|');
    return { messageBody: body, bcc: bcc === 'NULL' ? null : bcc };
  },

  deliveryError(email: string, messageTypeName: string): string | null {
    const row = querySingleValue(
      `SELECT TOP 1 CONCAT(CAST(ISNULL(InError, 0) AS int), '|', ISNULL(ErrorMessage, ''))
       FROM auth.SystemNotifications WHERE NotifcationTo = N'${email}' AND MessageTypeName = N'${messageTypeName}' ORDER BY SystemNotificationId DESC`,
    );
    if (!row) return `No ${messageTypeName} notification was recorded for ${email}.`;
    const [inError, message] = [row.slice(0, row.indexOf('|')), row.slice(row.indexOf('|') + 1)];
    return inError === '1' ? message || 'InError with no message' : null;
  },

  notificationCount(email: string): number {
    return Number(querySingleValue(`SELECT COUNT(*) FROM auth.SystemNotifications WHERE NotifcationTo = N'${email}'`));
  },

  hostBccIsSet(): boolean {
    return (
      querySingleValue(
        `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = N'EmailSettings' AND PropertyName = N'bcc' AND LEN(PropertyValue) > 0`,
      ) !== '0'
    );
  },

  count(): number {
    return Number(querySingleValue(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC800.%@EXAMPLE.COM'`));
  },

  remove(): string {
    return runSeedScript('host-qc800.remove.sql');
  },
};

export class ForgotPasswordPage {
  readonly email: Locator;
  readonly send: Locator;
  readonly toast: Locator;

  constructor(private readonly page: Page) {
    this.email = page.locator('app-forgot-password input[formcontrolname="email"]');
    this.send = page.locator('app-forgot-password button[type="submit"]');
    this.toast = page.locator('.success-snackbar');
  }

  async open(): Promise<void> {
    await this.page.goto(`${env.appUrl}/#/authentication/forgot-password`);
    await expect(this.email).toBeVisible({ timeout: 30_000 });
  }

  async requestLink(email: string): Promise<void> {
    await this.email.fill(email);
    await PasswordRequestPacer.waitForSlot();
    PasswordRequestPacer.note();
    await this.send.click();
  }
}

export class ResetPasswordPage {
  readonly title: Locator;
  readonly password: Locator;
  readonly confirmPassword: Locator;
  readonly submit: Locator;
  readonly success: Locator;
  readonly error: Locator;
  readonly requestNewLink: Locator;

  constructor(private readonly page: Page) {
    this.title = page.locator('app-reset-password .title h3');
    this.password = page.locator('app-reset-password input[formcontrolname="password"]');
    this.confirmPassword = page.locator('app-reset-password input[formcontrolname="confirmPassword"]');
    this.submit = page.locator('app-reset-password button[type="submit"]');
    this.success = page.locator('app-reset-password .alert-success');
    this.error = page.locator('app-reset-password .alert-danger');
    this.requestNewLink = this.error.locator('a[href*="forgot-password"]');
  }

  async open(link: PasswordLinkUrl): Promise<void> {
    await this.page.goto(appLinkFor(link));
    await expect(this.password).toBeVisible({ timeout: 30_000 });
  }

  async setPassword(password: string): Promise<void> {
    await this.password.fill(password);
    await this.confirmPassword.fill(password);
    await PasswordRequestPacer.waitForSlot();
    PasswordRequestPacer.note();
    await this.submit.click();
  }
}
