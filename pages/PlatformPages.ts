import * as path from 'path';
import { expect, type Locator, type Page } from '@playwright/test';
import { env } from '../config/environment';
import { AdminApi } from './AdminApi';
import { openAdmin, waitForIdle } from './AdminShell';

export const PLATFORM_SETTING_GROUPS = [
  'Admin sign-in',
  'Admin branding',
  'Identity cache',
  'Sessions',
  'Token lifetimes',
  'Password policy',
  'Lockout',
  'Throttles',
  'Email sender',
  'Activity log',
];

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

  constructor(private readonly page: Page) {
    this.root = page.locator('#settings-page');
    this.groups = page.locator('[data-settings-group]');
    this.loadError = page.locator('#settings-load-error');
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
