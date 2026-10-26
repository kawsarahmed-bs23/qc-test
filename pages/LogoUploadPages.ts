import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { queryIdentityDb, runIdentitySeedScript, runSeedScript } from '../fixtures/localDb';
import { newAuthenticatorKey } from '../fixtures/totp';
import { IdentityLoginPage } from './IdentityLoginPage';

export type LogoType = 'logo-main' | 'logo-menu' | 'logo-system' | 'logo-icon' | 'logo-large';

export const LOGO_CARD_TITLES: Record<LogoType, string> = {
  'logo-main': 'Main Logo',
  'logo-menu': 'Menu Logo',
  'logo-system': 'System Logo',
  'logo-icon': 'Favicon',
  'logo-large': 'Large Logo',
};

export interface UploadFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface SentFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface DecodedImage {
  width: number;
  height: number;
  topLeft: [number, number, number, number];
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function pngColourType(bytes: Buffer): number | null {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  return bytes[25];
}

function recordFormFiles(): void {
  const w = window as unknown as { __e2eFormFiles?: File[] };
  if (w.__e2eFormFiles) return;
  w.__e2eFormFiles = [];
  const append = FormData.prototype.append;
  FormData.prototype.append = function (this: FormData, ...args: [string, string | Blob, string?]) {
    if (args[1] instanceof File) w.__e2eFormFiles!.push(args[1]);
    return (append as (...a: unknown[]) => void).apply(this, args);
  } as typeof FormData.prototype.append;
}

async function recordedFileCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __e2eFormFiles?: File[] }).__e2eFormFiles?.length ?? 0);
}

async function recordedFile(page: Page, index: number): Promise<SentFile> {
  const file = await page.evaluate(async (i) => {
    const sent = (window as unknown as { __e2eFormFiles: File[] }).__e2eFormFiles[i];
    const bytes = new Uint8Array(await sent.arrayBuffer());
    let binary = '';
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return { fileName: sent.name, contentType: sent.type, base64: btoa(binary) };
  }, index);
  return { fileName: file.fileName, contentType: file.contentType, bytes: Buffer.from(file.base64, 'base64') };
}

export async function decodeImage(page: Page, bytes: Buffer): Promise<DecodedImage> {
  return page.evaluate(async (base64) => {
    const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([raw]));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const pixel = Array.from(context.getImageData(0, 0, 1, 1).data) as [number, number, number, number];
    return { width: bitmap.width, height: bitmap.height, topLeft: pixel };
  }, bytes.toString('base64'));
}

export class CompanyLogoCard {
  readonly card: Locator;
  readonly fileInput: Locator;
  readonly preview: Locator;

  constructor(page: Page, readonly type: LogoType) {
    this.card = page.locator('.image-upload-card').filter({ has: page.locator('h6', { hasText: LOGO_CARD_TITLES[type] }) });
    this.fileInput = this.card.locator('input[type="file"]');
    this.preview = this.card.locator('.image-preview-box img');
  }
}

export class LogoCropper {
  readonly popup: Locator;
  readonly save: Locator;
  readonly rotateClockwise: Locator;
  readonly rotateAnticlockwise: Locator;
  readonly cancel: Locator;
  readonly croppedImage: Locator;

  constructor(private readonly page: Page) {
    this.popup = page.locator('app-ticket-cropper .ticket-cropper-popup');
    this.save = this.popup.getByRole('button', { name: 'Save/Change' });
    this.rotateClockwise = this.popup.getByRole('button', { name: 'Rotate 90°', exact: true });
    this.rotateAnticlockwise = this.popup.getByRole('button', { name: 'Rotate -90°' });
    this.cancel = this.popup.getByRole('button', { name: 'Cancel' });
    this.croppedImage = this.popup.locator('image-cropper img');
  }

  async expectOpen(): Promise<void> {
    await expect(this.popup).toBeVisible();
    await expect(this.croppedImage.first()).toBeVisible();
    await expect
      .poll(() => this.page.evaluate(() => {
        const ng = (window as unknown as { ng?: { getComponent(el: Element): any } }).ng;
        const host = document.querySelector('app-ticket-cropper');
        if (!ng || !host) throw new Error('Angular dev-mode debug API is not available for app-ticket-cropper.');
        const cropper = ng.getComponent(host);
        return !!cropper.croppedImageBase64 && cropper.croppedImageBase64 !== cropper.imageBase64;
      }), { message: 'the cropper emits its first cropped image' })
      .toBe(true);
    await this.installSpy();
  }

  async cropCount(): Promise<number> {
    return this.page.evaluate(() => (window as unknown as { __e2eCropCount?: number }).__e2eCropCount ?? 0);
  }

  async outputFormat(): Promise<string> {
    return this.page.evaluate(() => {
      const ng = (window as unknown as { ng?: { getComponent(el: Element): any } }).ng;
      const host = document.querySelector('app-ticket-cropper');
      if (!ng || !host) throw new Error('Angular dev-mode debug API is not available for app-ticket-cropper.');
      return ng.getComponent(host).outputFormat as string;
    });
  }

  async rotate(direction: 'clockwise' | 'anticlockwise'): Promise<void> {
    const before = await this.cropCount();
    await (direction === 'clockwise' ? this.rotateClockwise : this.rotateAnticlockwise).click();
    await expect.poll(() => this.cropCount(), { message: 'the cropper emits a cropped image after the rotation' }).toBeGreaterThan(before);
  }

  private async installSpy(): Promise<void> {
    await this.page.evaluate(() => {
      const ng = (window as unknown as { ng?: { getComponent(el: Element): any } }).ng;
      const host = document.querySelector('app-ticket-cropper');
      if (!ng || !host) throw new Error('Angular dev-mode debug API is not available for app-ticket-cropper.');
      const cropper = ng.getComponent(host);
      if (cropper.__e2eWrapped) return;
      const original = cropper.handleImageCropped.bind(cropper);
      cropper.handleImageCropped = (event: unknown) => {
        original(event);
        const w = window as unknown as { __e2eCropCount?: number };
        w.__e2eCropCount = (w.__e2eCropCount ?? 0) + 1;
      };
      cropper.__e2eWrapped = true;
    });
  }
}

export class AppHeader {
  readonly logoBox: Locator;
  readonly logo: Locator;
  readonly companyName: Locator;
  readonly rightSide: Locator;

  constructor(private readonly page: Page) {
    const header = page.locator('header.header-area');
    this.logoBox = header.locator('.logo-image');
    this.logo = this.logoBox.locator('img');
    this.companyName = header.locator('.logo-image + h4');
    this.rightSide = header.locator('.header-right-side');
  }

  async logoSrc(): Promise<string> {
    return (await this.logo.getAttribute('src')) ?? '';
  }

  async waitForLogoChange(previousSrc: string): Promise<string> {
    await expect.poll(() => this.logoSrc(), { message: 'the header logo switches to the new upload', timeout: 20_000 }).not.toBe(previousSrc);
    await expect
      .poll(() => this.logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 20_000 })
      .toBe(true);
    return this.logoSrc();
  }

  async box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await locator.boundingBox();
    if (!box) throw new Error('Element is not rendered.');
    return box;
  }

  async companyNameIsOnTop(): Promise<boolean> {
    return this.companyName.evaluate((h4) => {
      const r = h4.getBoundingClientRect();
      const points = [
        [r.left + 2, r.top + r.height / 2],
        [r.left + r.width / 2, r.top + r.height / 2],
        [r.right - 2, r.top + r.height / 2],
      ];
      return points.every(([x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (hit === h4 || h4.contains(hit));
      });
    });
  }

  async logoCornerPixel(): Promise<[number, number, number, number]> {
    const shot = await this.logo.screenshot();
    return this.page.evaluate(async (base64) => {
      const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(3, 3, 1, 1).data) as [number, number, number, number];
    }, shot.toString('base64'));
  }
}

export class LogoSettingsPage {
  readonly heading: Locator;
  readonly cropper: LogoCropper;
  readonly header: AppHeader;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Company Settings' }).first();
    this.cropper = new LogoCropper(page);
    this.header = new AppHeader(page);
  }

  card(type: LogoType): CompanyLogoCard {
    return new CompanyLogoCard(this.page, type);
  }

  async open(): Promise<void> {
    await this.page.addInitScript(recordFormFiles);
    const loaded = this.page.waitForResponse((r) => r.url().includes('/api/setting/host-setting') && r.request().method() === 'GET');
    await this.page.goto('/#/admin/settings');
    expect((await loaded).status(), 'GET host-setting').toBe(200);
    await this.page.evaluate(recordFormFiles);
    await expect(this.heading).toBeVisible({ timeout: 30_000 });
    await expect(this.header.logo).toBeVisible();
  }

  async chooseFile(type: LogoType, file: UploadFile): Promise<void> {
    await this.card(type).fileInput.setInputFiles(file);
    await this.cropper.expectOpen();
  }

  async saveCropped(type: LogoType): Promise<{ status: number; sent: SentFile }> {
    const uploaded = this.page.waitForResponse(
      (r) => r.url().endsWith(`/api/setting/logo/${type}`) && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    const before = await recordedFileCount(this.page);
    await this.cropper.save.click();
    const response = await uploaded;
    expect(await recordedFileCount(this.page), 'the upload appended one file to its form data').toBe(before + 1);
    return { status: response.status(), sent: await recordedFile(this.page, before) };
  }
}

export class HostLogoApi {
  private constructor(
    private readonly page: Page,
    private readonly token: string,
  ) {}

  static async signedIn(page: Page): Promise<HostLogoApi> {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set for this environment.');
    await page.goto('/#/dashboard/dispatch-dashboard');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
    const token = await page.evaluate(() => localStorage.getItem('accessToken'));
    return new HostLogoApi(page, token!);
  }

  async logoUrl(type: LogoType): Promise<string | null> {
    const key = `${type.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Url`;
    const response = await this.page.request.get(`${env.appApiUrl}/api/setting/public/company-settings`);
    expect(response.status(), 'GET public/company-settings').toBe(200);
    return ((await response.json())?.data?.[key] as string | null) ?? null;
  }

  async download(url: string): Promise<{ bytes: Buffer; contentType: string }> {
    const response = await this.page.request.get(url);
    expect(response.status(), `GET ${new URL(url).pathname}`).toBe(200);
    return { bytes: await response.body(), contentType: response.headers()['content-type'] ?? '' };
  }

  async upload(type: LogoType, file: UploadFile): Promise<number> {
    const response = await this.page.request.post(`${env.appApiUrl}/api/setting/logo/${type}`, {
      headers: { Authorization: `Bearer ${this.token}` },
      multipart: { file },
    });
    return response.status();
  }

  async remove(type: LogoType): Promise<number> {
    const response = await this.page.request.delete(`${env.appApiUrl}/api/setting/logo/${type}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    return response.status();
  }
}

export class TicketUploadScreen {
  readonly fileInput: Locator;
  readonly firstEdit: Locator;
  readonly cropper: LogoCropper;

  constructor(private readonly page: Page) {
    const upload = page.locator('app-ticket-upload');
    this.fileInput = upload.locator('file-upload input[type="file"]');
    this.firstEdit = upload.locator('.image-item').first().getByRole('button', { name: 'Edit' });
    this.cropper = new LogoCropper(page);
  }

  async open(): Promise<void> {
    await this.page.goto('/#/tickets/tickets-upload');
    await expect(this.fileInput).toBeAttached({ timeout: 30_000 });
  }

  async selectedFile(index = 0): Promise<SentFile> {
    const file = await this.page.evaluate(async (i) => {
      const ng = (window as unknown as { ng?: { getComponent(el: Element): any } }).ng;
      const host = document.querySelector('app-ticket-upload');
      if (!ng || !host) throw new Error('Angular dev-mode debug API is not available for app-ticket-upload.');
      const selected: File = ng.getComponent(host).selectedFiles[i];
      const bytes = new Uint8Array(await selected.arrayBuffer());
      let binary = '';
      bytes.forEach((b) => (binary += String.fromCharCode(b)));
      return { fileName: selected.name, contentType: selected.type, base64: btoa(binary) };
    }, index);
    return { fileName: file.fileName, contentType: file.contentType, bytes: Buffer.from(file.base64, 'base64') };
  }
}

export const QC803_ADMIN_EMAIL = 'e2e.qc803.logoadmin@quarryconnect.test';
export const QC803_ADMIN_STATE = path.join('.auth', env.name, 'qc803-app-admin.json');

export class ThrowawayHostAdmin {
  static seed(): { email: string; password: string; authenticatorKey: string } {
    if (!env.admin) throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway host admin copies that password.');
    const authenticatorKey = newAuthenticatorKey();
    runIdentitySeedScript('identity-qc803-user.apply.sql', {
      Email: QC803_ADMIN_EMAIL,
      SourceEmail: env.admin.email,
      LastName: 'QC-803 Logo admin',
      TwoFactor: '1',
      AuthenticatorKey: authenticatorKey,
    });
    const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(N'${QC803_ADMIN_EMAIL}')`);
    if (!userId) throw new Error(`The throwaway user ${QC803_ADMIN_EMAIL} was not created.`);
    runSeedScript('host-qc803-admin.apply.sql', { UserId: userId, Email: QC803_ADMIN_EMAIL });
    return { email: QC803_ADMIN_EMAIL, password: env.admin.password, authenticatorKey };
  }

  static async signIn(browser: Browser): Promise<void> {
    const user = ThrowawayHostAdmin.seed();
    const context = await browser.newContext({
      baseURL: env.appUrl ?? undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      storageState: { cookies: [], origins: [] },
    });
    try {
      const page = await context.newPage();
      await page.goto('/#/authentication');
      await new IdentityLoginPage(page).signInWithTwoStep(user, user.authenticatorKey);
      await page.waitForURL((url) => url.origin === new URL(env.appUrl!).origin, { timeout: 30_000 });
      await expect.poll(() => page.evaluate(() => localStorage.getItem('accessToken')), { timeout: 30_000 }).toBeTruthy();
      fs.mkdirSync(path.dirname(QC803_ADMIN_STATE), { recursive: true });
      await context.storageState({ path: QC803_ADMIN_STATE });
    } finally {
      await context.close();
    }
  }

  static remove(): void {
    runSeedScript('host-qc803.remove.sql');
    runIdentitySeedScript('identity-qc803.remove.sql', { EmailLike: 'e2e.qc803.%@quarryconnect.test' });
    fs.rmSync(QC803_ADMIN_STATE, { force: true });
  }
}
