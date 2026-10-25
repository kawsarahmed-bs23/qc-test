import { expect, type Locator, type Page } from '@playwright/test';
import { ConfirmDialog, openAdmin, waitForIdle } from './AdminShell';

export type HostField = 'Name' | 'HostKey' | 'ClientId' | 'DatabaseName' | 'HostOrganisationId' | 'UiUrl' | 'ApiBaseUrl';

export type HostErrorKey = 'name' | 'hostKey' | 'clientId' | 'databaseName' | 'hostOrganisationId' | 'uiUrl' | 'apiBaseUrl';

export interface NewHost {
  name: string;
  hostKey: string;
  clientId: string;
  databaseName: string;
  organisationId: string;
  uiUrl: string;
  apiBaseUrl?: string;
}

export async function chooseOption(page: Page, select: Locator, option: string | RegExp): Promise<void> {
  await select.click();
  const choice = page.locator('.cdk-overlay-container mat-option').filter({ hasText: option }).first();
  await choice.click();
  await expect(page.locator('.cdk-overlay-container mat-option')).toHaveCount(0);
}

export function selectedText(select: Locator): Locator {
  return select.locator('.mat-mdc-select-value');
}

export class HostListPage {
  readonly table: Locator;
  readonly rows: Locator;
  readonly add: Locator;
  readonly empty: Locator;
  readonly error: Locator;

  constructor(private readonly page: Page) {
    this.table = page.locator('#hosts-table');
    this.rows = page.locator('#hosts-table tr[data-host-uuid]');
    this.add = page.locator('#host-add');
    this.empty = page.locator('#hosts-empty');
    this.error = page.locator('#hosts-error');
  }

  async open(): Promise<void> {
    await openAdmin(this.page, '/hosts');
    await expect(this.page.locator('#page-heading')).toHaveText('Hosts');
    await expect(this.rows.first().or(this.empty).or(this.error)).toBeVisible();
  }

  row(uuid: string): Locator {
    return this.page.locator(`#hosts-table tr[data-host-uuid="${uuid}" i]`);
  }

  link(uuid: string): Locator {
    return this.row(uuid).locator('[data-testid="host-link"]');
  }

  async clientIds(): Promise<string[]> {
    return (await this.rows.locator('td.mat-column-clientId').allInnerTexts()).map((text) => text.trim());
  }
}

export class HostFormPage {
  readonly newForm: Locator;
  readonly detailForm: Locator;
  readonly create: Locator;
  readonly cancel: Locator;
  readonly save: Locator;
  readonly formError: Locator;
  readonly facts: Locator;
  readonly uuid: Locator;
  readonly hostKey: Locator;
  readonly clientId: Locator;
  readonly dangerZone: Locator;
  readonly deactivate: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.newForm = page.locator('#host-new-form');
    this.detailForm = page.locator('#host-detail-form');
    this.create = page.locator('#host-create');
    this.cancel = page.locator('#host-cancel');
    this.save = page.locator('#host-save');
    this.formError = page.locator('#host-form-error');
    this.facts = page.locator('#host-facts');
    this.uuid = page.locator('#host-uuid');
    this.hostKey = page.locator('#host-key');
    this.clientId = page.locator('#host-client-id');
    this.dangerZone = page.locator('#host-danger-zone');
    this.deactivate = page.locator('#host-deactivate');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async openNew(): Promise<void> {
    await openAdmin(this.page, '/hosts/new');
    await expect(this.page.locator('#page-heading')).toHaveText('Add host');
    await expect(this.newForm).toBeVisible();
  }

  async openDetail(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}`);
    await expect(this.detailForm).toBeVisible();
    await waitForIdle(this.page);
  }

  field(name: HostField): Locator {
    return this.page.locator(`#Input_${name}`);
  }

  error(key: HostErrorKey): Locator {
    return this.page.locator(`[data-field-error="${key}"]`);
  }

  clientError(name: HostField): Locator {
    return this.page.locator('.qc-field').filter({ has: this.field(name) }).locator('.qc-field-error:not([data-field-error])');
  }

  async fill(host: NewHost): Promise<void> {
    await this.field('Name').fill(host.name);
    await this.field('HostKey').fill(host.hostKey);
    await this.field('ClientId').fill(host.clientId);
    await this.field('DatabaseName').fill(host.databaseName);
    await this.field('HostOrganisationId').fill(host.organisationId);
    await this.field('UiUrl').fill(host.uiUrl);
    await this.field('ApiBaseUrl').fill(host.apiBaseUrl ?? '');
  }
}

export class HostFeaturesPage {
  readonly form: Locator;
  readonly save: Locator;
  readonly errors: Locator;
  readonly ruleErrors: Locator;
  readonly productError: Locator;
  readonly empty: Locator;
  readonly mfaForm: Locator;
  readonly mfa: Locator;
  readonly mfaSave: Locator;

  constructor(private readonly page: Page) {
    this.form = page.locator('#product-features');
    this.save = page.locator('#features-save');
    this.errors = page.locator('#feature-errors');
    this.ruleErrors = page.locator('#feature-errors [data-testid="feature-rule-error"]');
    this.productError = page.locator('#features-error');
    this.empty = page.locator('#features-empty');
    this.mfaForm = page.locator('#mfa-form');
    this.mfa = page.locator('#mfa-enabled button[role="switch"]');
    this.mfaSave = page.locator('#mfa-save');
  }

  async open(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/features`);
    await expect(this.save).toBeVisible();
    await waitForIdle(this.page);
  }

  async openUnreachable(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/features`);
    await expect(this.savedCopy).toBeVisible();
  }

  get savedCopy(): Locator {
    return this.page.locator('#features-saved-copy');
  }

  savedFeature(key: string): Locator {
    return this.page.locator(`#features-saved-copy [data-saved-feature="${key}"]`);
  }

  feature(key: string): Locator {
    return this.page.locator(`#product-features mat-checkbox[data-feature="${key}"]`);
  }

  checkbox(key: string): Locator {
    return this.feature(key).locator('input[type="checkbox"]');
  }

  row(key: string): Locator {
    return this.page.locator(`#product-features li[data-feature-row="${key}"]`);
  }

  rule(key: string): Locator {
    return this.page.locator(`#product-features [data-rule-for="${key}"]`);
  }

  async featureKeys(): Promise<string[]> {
    return this.page.locator('#product-features mat-checkbox[data-feature]').evaluateAll((boxes) =>
      boxes.map((box) => box.getAttribute('data-feature')!),
    );
  }

  async enabledKeys(): Promise<string[]> {
    return this.page.locator('#product-features mat-checkbox[data-feature]').evaluateAll((boxes) =>
      boxes.filter((box) => (box.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).map((box) => box.getAttribute('data-feature')!),
    );
  }

  async isOn(key: string): Promise<boolean> {
    return this.checkbox(key).isChecked();
  }

  async setOn(key: string, on: boolean): Promise<void> {
    if ((await this.isOn(key)) !== on) {
      await this.checkbox(key).click();
    }
    await expect(this.checkbox(key)).toBeChecked({ checked: on });
  }

  async mfaOn(): Promise<boolean> {
    return (await this.mfa.getAttribute('aria-checked')) === 'true';
  }

  async setMfa(on: boolean): Promise<void> {
    if ((await this.mfaOn()) !== on) {
      await this.mfa.click();
    }
    await expect(this.mfa).toHaveAttribute('aria-checked', on ? 'true' : 'false');
  }
}

export const OPEN_GROUPS_KEY = 'adminEnvironment.openGroups';

export class RestartControls {
  readonly arm: Locator;
  readonly confirm: Locator;
  readonly cancel: Locator;

  constructor(scope: Page | Locator, prefix: 'restart' | 'restart-card') {
    this.arm = scope.locator(`#${prefix}-arm`);
    this.confirm = scope.locator(`#${prefix}-confirm`);
    this.cancel = scope.locator(`#${prefix}-cancel`);
  }
}

export class RestartCountdownDialog {
  readonly root: Locator;
  readonly keys: Locator;
  readonly seconds: Locator;
  readonly restartNow: Locator;
  readonly notNow: Locator;

  constructor(page: Page) {
    this.root = page.locator('app-restart-countdown-dialog');
    this.keys = this.root.locator('.restart-countdown-dialog__keys li');
    this.seconds = this.root.locator('.restart-countdown-dialog__countdown strong');
    this.restartNow = this.root.getByRole('button', { name: 'Restart now' });
    this.notNow = this.root.getByRole('button', { name: 'Not now' });
  }

  async secondsLeft(): Promise<number> {
    return Number((await this.seconds.innerText()).trim());
  }

  async decline(): Promise<void> {
    await expect(this.root).toBeVisible();
    await this.notNow.click();
    await expect(this.root).toHaveCount(0);
  }
}

export class HostEnvironmentPage {
  readonly form: Locator;
  readonly intro: Locator;
  readonly save: Locator;
  readonly reset: Locator;
  readonly loadWarning: Locator;
  readonly empty: Locator;
  readonly restartCard: Locator;
  readonly restartCardKeys: Locator;
  readonly restart: RestartControls;
  readonly cardRestart: RestartControls;
  readonly countdown: RestartCountdownDialog;

  constructor(private readonly page: Page) {
    this.form = page.locator('#environment-form');
    this.intro = page.locator('#environment-intro');
    this.save = page.locator('#environment-save');
    this.reset = page.locator('#environment-reset');
    this.loadWarning = page.locator('#environment-error');
    this.empty = page.locator('#environment-empty');
    this.restartCard = page.locator('#restart-card');
    this.restartCardKeys = page.locator('#restart-card li');
    this.restart = new RestartControls(page, 'restart');
    this.cardRestart = new RestartControls(page, 'restart-card');
    this.countdown = new RestartCountdownDialog(page);
  }

  async open(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/environment`);
    await expect(this.save).toBeVisible();
    await waitForIdle(this.page);
  }

  async openUnreachable(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/environment`);
    await expect(this.savedCopy).toBeVisible();
  }

  get savedCopy(): Locator {
    return this.page.locator('#environment-saved-copy');
  }

  groups(): Locator {
    return this.page.locator('mat-expansion-panel[data-group][data-group-name]');
  }

  group(name: string): Locator {
    return this.page.locator(`mat-expansion-panel[data-group][data-group-name="${name}"]`);
  }

  groupHeader(name: string): Locator {
    return this.group(name).locator('mat-expansion-panel-header');
  }

  groupOf(key: string): Locator {
    return this.groups().filter({ has: this.page.locator(`[data-key="${key}"]`) });
  }

  async groupNames(): Promise<string[]> {
    return this.groups().evaluateAll((panels) => panels.map((panel) => panel.getAttribute('data-group-name')!));
  }

  async isExpanded(name: string): Promise<boolean> {
    return (await this.groupHeader(name).getAttribute('aria-expanded')) === 'true';
  }

  async setExpanded(name: string, open: boolean): Promise<void> {
    if ((await this.isExpanded(name)) !== open) {
      await this.groupHeader(name).click();
    }
    await expect(this.groupHeader(name)).toHaveAttribute('aria-expanded', String(open));
  }

  async reveal(key: string): Promise<void> {
    const name = await this.groupOf(key).getAttribute('data-group-name');
    await this.setExpanded(name!, true);
    await expect(this.field(key)).toBeVisible();
  }

  rows(): Locator {
    return this.page.locator('[data-setting-id][data-key]');
  }

  field(key: string): Locator {
    return this.page.locator(`[data-setting-id][data-key="${key}"]`);
  }

  async settingId(key: string): Promise<string> {
    return (await this.field(key).getAttribute('data-setting-id'))!;
  }

  input(key: string): Locator {
    return this.field(key).locator('input, textarea, mat-select').first();
  }

  error(key: string): Locator {
    return this.field(key).locator('mat-error');
  }

  hint(key: string): Locator {
    return this.field(key).locator('mat-hint');
  }

  secretInputs(): Locator {
    return this.page.locator('[data-setting-id][data-key] input[type="password"]');
  }

  secretFields(): Locator {
    return this.rows().filter({ has: this.page.locator('input[type="password"]') });
  }

  async setValue(key: string, value: string): Promise<void> {
    await this.reveal(key);
    await this.input(key).fill(value);
  }

  async openGroupsStored(): Promise<string[] | null> {
    const raw = await this.page.evaluate((key) => localStorage.getItem(key), OPEN_GROUPS_KEY);
    return raw === null ? null : (JSON.parse(raw) as string[]);
  }

  async forgetOpenGroups(): Promise<void> {
    await this.page.evaluate((key) => localStorage.removeItem(key), OPEN_GROUPS_KEY);
  }

  savedSetting(group: string, subGroupAndProperty: string): Locator {
    return this.page
      .locator('#environment-saved-copy [data-testid="saved-group"]')
      .filter({ has: this.page.locator('h5', { hasText: new RegExp(`^\\s*${group}\\s*$`) }) })
      .locator(`tr[data-saved-setting="${subGroupAndProperty}"]`);
  }
}

export type BrandingField = 'displayName' | 'logoUrl' | 'faviconUrl' | 'primaryColor' | 'accentColor';

export type AllowedUrlField = 'returnUrls' | 'signOutUrls' | 'corsOrigins' | 'backChannelLogoutUrl';

export interface HostBranding {
  displayName: string;
  logoUrl: string;
  faviconUrl: string;
  primaryColor: string;
  accentColor: string;
}

export interface HostAllowedUrls {
  returnUrls: string[];
  signOutUrls: string[];
  corsOrigins: string[];
  backChannelLogoutUrl: string;
}

export const BRANDING_FIELDS: BrandingField[] = ['displayName', 'logoUrl', 'faviconUrl', 'primaryColor', 'accentColor'];

export class HostSignInSettingsPage {
  readonly brandingForm: Locator;
  readonly brandingSave: Locator;
  readonly brandingError: Locator;
  readonly urlsForm: Locator;
  readonly urlsSave: Locator;
  readonly urlsError: Locator;
  readonly loadError: Locator;

  constructor(private readonly page: Page) {
    this.brandingForm = page.locator('#branding-form');
    this.brandingSave = page.locator('#branding-save');
    this.brandingError = page.locator('#branding-error');
    this.urlsForm = page.locator('#urls-form');
    this.urlsSave = page.locator('#urls-save');
    this.urlsError = page.locator('#urls-error');
    this.loadError = page.locator('#sign-in-load-error');
  }

  async open(uuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/sign-in`);
    await expect(this.brandingForm).toBeVisible();
    await expect(this.urlsForm).toBeVisible();
    await waitForIdle(this.page);
  }

  branding(field: BrandingField): Locator {
    return this.page.locator(`#branding-${field}`);
  }

  urls(field: AllowedUrlField): Locator {
    return this.page.locator(`#urls-${field}`);
  }

  fieldError(field: BrandingField | AllowedUrlField): Locator {
    return this.page.locator(`[data-field-error="${field}"]`);
  }

  async readBranding(): Promise<HostBranding> {
    const values = await Promise.all(BRANDING_FIELDS.map((field) => this.branding(field).inputValue()));
    return Object.fromEntries(BRANDING_FIELDS.map((field, i) => [field, values[i]])) as unknown as HostBranding;
  }

  async fillBranding(branding: Partial<HostBranding>): Promise<void> {
    for (const [field, value] of Object.entries(branding) as [BrandingField, string][]) {
      await this.branding(field).fill(value);
    }
  }

  async readUrls(): Promise<HostAllowedUrls> {
    const lines = async (field: AllowedUrlField) =>
      (await this.urls(field).inputValue())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return {
      returnUrls: await lines('returnUrls'),
      signOutUrls: await lines('signOutUrls'),
      corsOrigins: await lines('corsOrigins'),
      backChannelLogoutUrl: (await this.urls('backChannelLogoutUrl').inputValue()).trim(),
    };
  }

  async fillUrls(urls: Partial<HostAllowedUrls>): Promise<void> {
    for (const [field, value] of Object.entries(urls) as [AllowedUrlField, string | string[]][]) {
      await this.urls(field).fill(Array.isArray(value) ? value.join('\n') : value);
    }
  }
}

export class UserDetailPage {
  readonly state: Locator;
  readonly facts: Locator;
  readonly email: Locator;
  readonly platformAdmin: Locator;
  readonly twoFactor: Locator;
  readonly deactivate: Locator;
  readonly reactivate: Locator;
  readonly error: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.state = page.locator('#account-state');
    this.facts = page.locator('#user-facts');
    this.email = page.locator('#user-email');
    this.platformAdmin = page.locator('#user-platform-admin');
    this.twoFactor = page.locator('#user-two-factor');
    this.deactivate = page.locator('#account-deactivate');
    this.reactivate = page.locator('#account-reactivate');
    this.error = page.locator('#user-error');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async open(userId: string): Promise<void> {
    await openAdmin(this.page, `/users/${userId}`);
    await expect(this.state).toBeVisible();
    await waitForIdle(this.page);
  }

  async setActive(active: boolean): Promise<void> {
    await (active ? this.reactivate : this.deactivate).click();
    await this.confirmDialog.accept();
  }
}
