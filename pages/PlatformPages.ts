import * as path from 'path';
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { AdminApi, type AdminApiResult } from './AdminApi';
import { ConfirmDialog, openAdmin, waitForIdle } from './AdminShell';
import { solidPng, type UploadFile } from './HostBrandingApi';

export const PLATFORM_SETTING_GROUPS = ['Admin sign-in', 'Admin branding', 'Identity cache'];

export const PLATFORM_BRANDING_IMAGES = [
  { type: 'logo-main', label: 'Main logo', contentType: 'image/png' },
  { type: 'logo-icon', label: 'Icon (favicon)', contentType: 'image/x-icon' },
  { type: 'login-background', label: 'Login background', contentType: 'image/jpeg' },
] as const;

export type PlatformImageType = (typeof PLATFORM_BRANDING_IMAGES)[number]['type'];

export interface PlatformBrandingImage {
  type: string;
  label: string;
  present: boolean;
  path: string | null;
  updated: string | null;
  updatedBy: string | null;
}

export interface PublicBrandingAnswer {
  status: number;
  contentType: string | null;
  headers: Record<string, string>;
  bytes: Buffer;
}

export function icoFromPng(name: string, png: UploadFile = solidPng('e2e-qc823-icon.png', 16, 16)): UploadFile {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = png.buffer.readUInt32BE(16) & 0xff;
  entry[1] = png.buffer.readUInt32BE(20) & 0xff;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.buffer.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return { name, mimeType: 'image/x-icon', buffer: Buffer.concat([header, entry, png.buffer]) };
}

export async function canvasJpeg(page: Page, name: string, width = 64, height = 48): Promise<UploadFile> {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#2c72ee';
      context.fillRect(0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.9);
    },
    [width, height],
  );
  return { name, mimeType: 'image/jpeg', buffer: Buffer.from(dataUrl.split(',')[1], 'base64') };
}

export class PlatformBrandingApi {
  constructor(
    private readonly api: AdminApi,
    private readonly request: APIRequestContext,
  ) {}

  async images(): Promise<PlatformBrandingImage[]> {
    const result = await this.api.get<PlatformBrandingImage[]>('/settings/branding/images');
    expect(result.status, 'GET api/settings/branding/images').toBe(200);
    return result.body;
  }

  upload(type: string, file: UploadFile): Promise<AdminApiResult> {
    return this.api.upload(`/settings/branding/images/${type}`, file);
  }

  remove(type: string): Promise<AdminApiResult> {
    return this.api.delete(`/settings/branding/images/${type}`);
  }

  async removeAll(): Promise<void> {
    for (const image of await this.images()) {
      if (image.present) {
        const result = await this.remove(image.type);
        expect(result.status, `removing ${image.type}: ${result.text}`).toBe(200);
      }
    }
  }

  async publicImage(type: string): Promise<PublicBrandingAnswer> {
    const response = await this.request.get(publicBrandingUrl(type), { maxRedirects: 0, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    const headers = response.headers();
    return { status: response.status(), contentType: headers['content-type'] ?? null, headers, bytes: await response.body() };
  }
}

export function publicBrandingUrl(type: string): string {
  if (!env.adminApiUrl) {
    throw new Error('ADMIN_API_URL is not set.');
  }
  return `${env.adminApiUrl}/api/public/branding/${type}`;
}

export interface PlatformSetting {
  settingUuid: string;
  key: string;
  value: string | null;
  type: string;
  description: string | null;
  isRestartRequired: boolean;
  min: number;
  max: number;
  maxLength: number;
  required: boolean;
  updatedBy: string | null;
  updated: string | null;
}

export interface PlatformSettingGroup {
  name: string;
  settings: PlatformSetting[];
}

export function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

export function reportScreenshotPath(name: string): string {
  return path.resolve(__dirname, '..', 'reports', env.name, process.env.RUN_ID ?? 'adhoc', 'screenshots', name);
}

export class PlatformSettingsApi {
  constructor(private readonly api: AdminApi) {}

  async groups(): Promise<PlatformSettingGroup[]> {
    const result = await this.api.get<PlatformSettingGroup[]>('/settings');
    expect(result.status, 'GET api/settings').toBe(200);
    return result.body;
  }

  async all(): Promise<Map<string, PlatformSetting>> {
    const settings = (await this.groups()).flatMap((group) => group.settings);
    return new Map(settings.map((setting) => [setting.key, setting]));
  }

  async setting(key: string): Promise<PlatformSetting> {
    const setting = (await this.all()).get(key);
    expect(setting, `platform setting ${key}`).toBeTruthy();
    return setting!;
  }

  async save(values: Record<string, string | null>) {
    const all = await this.all();
    const byUuid: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(values)) {
      const setting = all.get(key);
      if (!setting) throw new Error(`No platform setting ${key}.`);
      byUuid[setting.settingUuid] = value;
    }
    return this.api.put<any>('/settings', { values: byUuid });
  }

  async restore(originals: Record<string, string | null>): Promise<void> {
    const result = await this.save(originals);
    expect(result.status, `restoring ${Object.keys(originals).join(', ')}: ${result.text}`).toBe(200);
  }
}

export class PlatformSettingsPage {
  readonly root: Locator;
  readonly groups: Locator;
  readonly loadError: Locator;
  readonly images: Locator;
  readonly imageTiles: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.root = page.locator('#settings-page');
    this.groups = page.locator('[data-settings-group]');
    this.loadError = page.locator('#settings-load-error');
    this.images = page.locator('#branding-images');
    this.imageTiles = this.images.locator('[data-image]');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async open(expandAll = true): Promise<void> {
    await openAdmin(this.page, '/settings');
    await expect(this.root).toBeVisible();
    await waitForIdle(this.page);
    await expect(this.groups.first()).toBeVisible();
    if (expandAll) {
      await this.expandAll();
    }
  }

  group(name: string): Locator {
    return this.page.locator(`#settings-group-${slug(name)}`);
  }

  header(name: string): Locator {
    return this.page.locator(`[data-settings-group-header="${name}"]`);
  }

  async expand(name: string): Promise<void> {
    const header = this.header(name);
    if ((await header.getAttribute('aria-expanded')) !== 'true') {
      await header.click();
    }
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  }

  async collapse(name: string): Promise<void> {
    const header = this.header(name);
    if ((await header.getAttribute('aria-expanded')) === 'true') {
      await header.click();
    }
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  }

  async expandAll(): Promise<void> {
    for (const name of PLATFORM_SETTING_GROUPS) {
      await this.expand(name);
    }
  }

  row(key: string): Locator {
    return this.page.locator(`[data-setting-key="${key}"]`);
  }

  input(key: string): Locator {
    return this.page.locator(`#setting-${slug(key)}`);
  }

  toggle(key: string): Locator {
    return this.page.locator(`#setting-${slug(key)} button[role="switch"]`);
  }

  restartBadge(key: string): Locator {
    return this.row(key).locator('[data-testid="setting-restart-required"]');
  }

  updatedHint(key: string): Locator {
    return this.row(key).locator('[data-testid="setting-updated"]');
  }

  fieldError(key: string): Locator {
    return this.page.locator(`[data-field-error="${key}"]`);
  }

  groupError(name: string): Locator {
    return this.page.locator(`[data-group-error="${name}"]`);
  }

  saveButton(group: string): Locator {
    return this.page.locator(`#settings-save-${slug(group)}`);
  }

  async save(group: string): Promise<void> {
    await this.saveButton(group).click();
  }

  imageTile(type: string): Locator {
    return this.images.locator(`[data-image="${type}"]`);
  }

  imagePreview(type: string): Locator {
    return this.imageTile(type).locator(`img[data-image-preview="${type}"]`);
  }

  imageEmpty(type: string): Locator {
    return this.imageTile(type).locator(`[data-image-empty="${type}"]`);
  }

  imageUpload(type: string): Locator {
    return this.page.locator(`#branding-upload-${type}`);
  }

  imageRemove(type: string): Locator {
    return this.page.locator(`#branding-remove-${type}`);
  }

  imageError(type: string): Locator {
    return this.imageTile(type).locator(`[data-field-error="${type}"]`);
  }

  async previewLoaded(type: string): Promise<boolean> {
    return this.imagePreview(type).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0);
  }

  async uploadImage(type: string, file: UploadFile): Promise<void> {
    await this.imageUpload(type).setInputFiles(file);
  }

  async removeImage(type: string): Promise<void> {
    await this.imageRemove(type).click();
    await this.confirmDialog.accept();
  }
}

export class PlatformAdminsPage {
  readonly table: Locator;
  readonly rows: Locator;
  readonly error: Locator;
  readonly search: Locator;
  readonly candidates: Locator;
  readonly candidatesEmpty: Locator;

  constructor(private readonly page: Page) {
    this.table = page.locator('#admins-table');
    this.rows = page.locator('#admins-table [data-admin-id]');
    this.error = page.locator('#admins-error');
    this.search = page.locator('#admin-search');
    this.candidates = page.locator('#admin-candidates [data-candidate-id]');
    this.candidatesEmpty = page.locator('#admin-candidates-empty');
  }

  async open(): Promise<void> {
    await openAdmin(this.page, '/admins');
    await expect(this.table).toBeVisible();
    await waitForIdle(this.page);
    await expect(this.rows.first()).toBeVisible();
  }

  row(userUuid: string): Locator {
    return this.page.locator(`#admins-table [data-admin-id="${userUuid}" i]`);
  }

  you(userUuid: string): Locator {
    return this.row(userUuid).locator('[data-testid="admin-you"]');
  }

  status(userUuid: string): Locator {
    return this.row(userUuid).locator('[data-testid="admin-status"]');
  }

  deactivate(userUuid: string): Locator {
    return this.row(userUuid).locator('[data-testid="admin-deactivate"]');
  }

  reactivate(userUuid: string): Locator {
    return this.row(userUuid).locator('[data-testid="admin-reactivate"]');
  }

  candidate(userUuid: string): Locator {
    return this.page.locator(`#admin-candidates [data-candidate-id="${userUuid}" i]`);
  }

  candidateAdd(userUuid: string): Locator {
    return this.candidate(userUuid).locator('[data-testid="candidate-add"]');
  }

  candidateIsAdmin(userUuid: string): Locator {
    return this.candidate(userUuid).locator('[data-testid="candidate-is-admin"]');
  }
}
