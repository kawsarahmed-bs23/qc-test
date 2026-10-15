import { expect, type Locator, type Page } from '@playwright/test';

export type HostTab = 'overview' | 'features' | 'environment' | 'settings';

export const LOGO_TYPES = ['logo-main', 'logo-menu', 'logo-system', 'logo-icon', 'logo-large'] as const;

export const AREAS = ['Features', 'Environment', 'HostSettings', 'Branding'] as const;

export function hostPath(uuid: string, tab: HostTab = 'overview'): string {
  return tab === 'overview' ? `/hosts/${uuid}` : `/hosts/${uuid}/${tab}`;
}

export class HostOverviewPage {
  constructor(private readonly page: Page) {}

  async open(uuid: string): Promise<void> {
    await this.page.goto(hostPath(uuid));
    await expect(this.page.locator('#sync-table')).toBeVisible();
  }

  areaRow(area: (typeof AREAS)[number]): Locator {
    return this.page.locator(`#sync-table tr[data-area="${area}"]`);
  }

  async driftOf(area: (typeof AREAS)[number]): Promise<string | null> {
    return this.areaRow(area).locator('[data-drift]').getAttribute('data-drift');
  }
}

export class FeaturesPage {
  readonly form: Locator;
  readonly save: Locator;
  readonly saveLabel: Locator;
  readonly errors: Locator;

  constructor(private readonly page: Page) {
    this.form = page.locator('#host-features-form');
    this.save = page.locator('#features-save');
    this.saveLabel = this.form.locator('[data-save-label]');
    this.errors = page.locator('[data-feature-errors]');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(hostPath(uuid, 'features'));
    await expect(this.form).toBeVisible();
  }

  toggle(key: string): Locator {
    return this.page.locator(`#feature-${key}`);
  }

  async isOn(key: string): Promise<boolean> {
    return (await this.toggle(key).getAttribute('aria-checked')) === 'true';
  }

  async setOn(key: string, on: boolean): Promise<void> {
    if ((await this.isOn(key)) !== on) {
      await this.toggle(key).click();
    }
    await expect(this.toggle(key)).toHaveAttribute('aria-checked', on ? 'true' : 'false');
  }

  warning(key: string): Locator {
    return this.page.locator(`[data-key="${key}"] [data-feature-warning]`);
  }
}

export class EnvironmentPage {
  readonly form: Locator;
  readonly save: Locator;
  readonly filter: Locator;
  readonly errors: Locator;
  readonly restartDialog: Locator;
  readonly restartCard: Locator;

  constructor(private readonly page: Page) {
    this.form = page.locator('#environment-form');
    this.save = page.locator('#environment-save');
    this.filter = page.locator('#setting-filter');
    this.errors = page.locator('#environment-errors');
    this.restartDialog = page.locator('[data-restart-modal]');
    this.restartCard = page.locator('[data-restart-card]');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(hostPath(uuid, 'environment'));
    await expect(this.form).toBeVisible();
  }

  row(key: string): Locator {
    return this.page.locator(`[data-setting-row][data-search^="${key.toLowerCase()} "]`);
  }

  input(key: string): Locator {
    return this.row(key).locator('input, select, textarea').first();
  }

  async reveal(key: string): Promise<void> {
    await this.filter.fill(key);
    await expect(this.row(key)).toBeVisible();
  }

  async setValue(key: string, value: string): Promise<void> {
    await this.reveal(key);
    await this.input(key).fill(value);
  }
}

export class SettingsPage {
  readonly form: Locator;
  readonly save: Locator;

  constructor(private readonly page: Page) {
    this.form = page.locator('#host-settings-form');
    this.save = page.locator('#settings-save');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(hostPath(uuid, 'settings'));
    await expect(this.form).toBeVisible();
  }

  field(name: string): Locator {
    return this.page.locator(`#setting-${name.replace(/\./g, '-')}`);
  }

  section(name: string): Locator {
    return this.page.locator(`[data-section="${name}"]`);
  }

  logoCard(type: (typeof LOGO_TYPES)[number]): Locator {
    return this.page.locator(`[data-logo-card][data-logo-type="${type}"]`);
  }
}

export class BrandingPage {
  readonly form: Locator;
  readonly save: Locator;
  readonly preview: Locator;
  readonly primaryColor: Locator;
  readonly displayName: Locator;

  constructor(private readonly page: Page) {
    this.form = page.locator('#sign-in-branding');
    this.save = page.locator('#branding-save');
    this.preview = page.locator('[data-preview]');
    this.primaryColor = page.locator('#Branding_PrimaryColor');
    this.displayName = page.locator('#Branding_DisplayName');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(`${hostPath(uuid, 'settings')}#sign-in-branding`);
    await expect(this.form).toBeVisible();
  }

  async previewBrandColor(): Promise<string> {
    return this.preview.evaluate((el) => getComputedStyle(el).getPropertyValue('--qc-brand').trim().toLowerCase());
  }
}
