import { expect, type Locator, type Page } from '@playwright/test';
import { AdminApi, type AdminApiResult } from '@api/admin.api';
import { ConfirmDialog, openAdmin, SIGN_IN_REDIRECT_TIMEOUT, waitForIdle } from '@pages/admin-shell.page';
import { BasePage } from './base.page';

export type ServiceSlug = 'drivers-api' | 'identity';

export interface ServiceSetting {
  settingUuid: string;
  key: string;
  value: string | null;
  type: string;
  description: string | null;
  isSensitive: boolean;
  hasValue: boolean;
  isRestartRequired: boolean;
  isRequired: boolean;
  updatedBy: string | null;
  updated: string;
}

export interface ServiceSettingGroup {
  name: string;
  settings: ServiceSetting[];
}

export interface ServiceSettings {
  service: ServiceSlug;
  displayName: string;
  groups: ServiceSettingGroup[];
}

export const SERVICE_SETTING_GROUPS: Record<ServiceSlug, string[]> = {
  'drivers-api': ['Identity', 'Cors', 'Swagger', 'Messaging', 'Push', 'TicketStorage', 'Ocr', 'Twilio', 'DriverLocation', 'AccountDeletion', 'Mirror'],
  identity: ['IdentityServer', 'Passkeys', 'Session', 'EmailSettings', 'Landing', 'Invites', 'PlatformClients'],
};

export const SERVICE_SETTING_COUNTS: Record<ServiceSlug, { total: number; secrets: number }> = {
  'drivers-api': { total: 58, secrets: 7 },
  identity: { total: 28, secrets: 3 },
};

export class ServiceSettingsApi {
  constructor(private readonly api: AdminApi) {}

  get(service: ServiceSlug | string): Promise<AdminApiResult<ServiceSettings>> {
    return this.api.get<ServiceSettings>(`/service-settings/${service}`);
  }

  async all(service: ServiceSlug): Promise<Map<string, ServiceSetting>> {
    const result = await this.get(service);
    expect(result.status, `GET service-settings/${service}`).toBe(200);
    return new Map(result.body.groups.flatMap((group) => group.settings).map((setting) => [setting.key, setting]));
  }

  async setting(service: ServiceSlug, key: string): Promise<ServiceSetting> {
    const setting = (await this.all(service)).get(key);
    expect(setting, `${service} ${key}`).toBeTruthy();
    return setting!;
  }

  async save(service: ServiceSlug, values: Record<string, string | null>, clears: string[] = []): Promise<AdminApiResult> {
    const all = await this.all(service);
    const byUuid = (key: string) => all.get(key)!.settingUuid;
    return this.api.put(`/service-settings/${service}`, {
      values: Object.fromEntries(Object.entries(values).map(([key, value]) => [byUuid(key), value])),
      clears: clears.map(byUuid),
    });
  }

  async restore(service: ServiceSlug, values: Record<string, string | null>): Promise<void> {
    const plain = Object.entries(values).filter(([, value]) => value !== null);
    const empty = Object.entries(values)
      .filter(([, value]) => value === null)
      .map(([key]) => key);
    const result = await this.save(service, Object.fromEntries(plain), empty);
    expect(result.status, `restore ${Object.keys(values).join(', ')}`).toBe(200);
  }
}

export class ServiceSettingsPage extends BasePage {
  protected readonly path = '/#/settings/services';
  readonly root: Locator;
  readonly tabs: Locator;
  readonly groups: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(page: Page) {
    super(page);
    this.root = page.locator('#service-settings-page');
    this.tabs = page.locator('#service-settings-tabs');
    this.groups = page.locator('[data-settings-group]');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async open(service: ServiceSlug = 'drivers-api'): Promise<void> {
    await openAdmin(this.page, `/settings/services?service=${service}`);
    await expect(this.root).toBeVisible({ timeout: SIGN_IN_REDIRECT_TIMEOUT });
    await expect(this.root).toHaveAttribute('data-service', service);
    await waitForIdle(this.page);
    await expect(this.groups.first()).toBeVisible();
  }

  tab(label: string): Locator {
    return this.tabs.getByRole('tab', { name: label });
  }

  async selectTab(label: string, service: ServiceSlug): Promise<void> {
    await this.tab(label).click();
    await expect(this.root).toHaveAttribute('data-service', service);
    await expect(this.groups.first()).toBeVisible();
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

  async groupNames(): Promise<string[]> {
    return this.groups.evaluateAll((cards) => cards.map((card) => card.getAttribute('data-settings-group') ?? ''));
  }

  row(key: string): Locator {
    return this.page.locator(`[data-setting-key="${key}"]`);
  }

  input(key: string): Locator {
    return this.page.locator(`#service-setting-${slug(key)}`);
  }

  toggle(key: string): Locator {
    return this.page.locator(`#service-setting-${slug(key)} button[role="switch"]`);
  }

  listItems(key: string): Locator {
    return this.row(key).locator('[data-list-item]');
  }

  async addListItem(key: string, value: string): Promise<void> {
    await this.input(key).fill(value);
    await this.input(key).press('Enter');
    await expect(this.row(key).locator(`[data-list-item="${value}"]`)).toBeVisible();
  }

  async removeListItem(key: string, value: string): Promise<void> {
    await this.row(key)
      .locator(`[data-list-item="${value}"]`)
      .getByRole('button', { name: `Remove ${value}` })
      .click();
    await expect(this.row(key).locator(`[data-list-item="${value}"]`)).toHaveCount(0);
  }

  secretState(key: string): Locator {
    return this.row(key).locator('[data-testid="secret-state"]');
  }

  secretReplace(key: string): Locator {
    return this.row(key).locator('[data-testid="secret-replace"]');
  }

  secretClear(key: string): Locator {
    return this.row(key).locator('[data-testid="secret-clear"]');
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
    return this.page.locator(`#service-settings-save-${slug(group)}`);
  }

  async save(group: string): Promise<void> {
    await this.saveButton(group).click();
  }
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}
