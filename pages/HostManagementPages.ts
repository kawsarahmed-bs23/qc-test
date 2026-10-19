import { expect, type Locator, type Page } from '@playwright/test';
import { ConfirmDialog, openAdmin, waitForIdle } from './AdminShell';

export type HostField = 'Name' | 'HostKey' | 'ClientId' | 'DatabaseName' | 'HostOrganisationId' | 'UiUrl' | 'ApiBaseUrl';

export type HostErrorKey = 'name' | 'hostKey' | 'clientId' | 'databaseName' | 'hostOrganisationId' | 'uiUrl' | 'apiBaseUrl' | 'identityHostId';

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
  readonly identityState: Locator;
  readonly facts: Locator;
  readonly uuid: Locator;
  readonly hostKey: Locator;
  readonly clientId: Locator;
  readonly linkField: Locator;
  readonly linkSelect: Locator;
  readonly identityPanel: Locator;
  readonly identityHostState: Locator;
  readonly identityClients: Locator;
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
    this.identityState = page.locator('#host-identity-state');
    this.facts = page.locator('#host-facts');
    this.uuid = page.locator('#host-uuid');
    this.hostKey = page.locator('#host-key');
    this.clientId = page.locator('#host-client-id');
    this.linkField = page.locator('#identity-link');
    this.linkSelect = page.locator('#Input_IdentityHostId');
    this.identityPanel = page.locator('#identity-panel');
    this.identityHostState = page.locator('#identity-host-state');
    this.identityClients = page.locator('#identity-clients-table tr[data-client-id]');
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

  identityClient(clientId: string): Locator {
    return this.page.locator(`#identity-clients-table tr[data-client-id="${clientId}"]`);
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
  readonly mfaError: Locator;

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
    this.mfaError = page.locator('#mfa-error');
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

  get savedMfa(): Locator {
    return this.page.locator('#mfa-saved-copy');
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

export class HostEnvironmentPage {
  readonly form: Locator;
  readonly save: Locator;
  readonly saveBottom: Locator;
  readonly filter: Locator;
  readonly errors: Locator;
  readonly loadWarning: Locator;
  readonly empty: Locator;
  readonly restartCard: Locator;
  readonly restart: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.form = page.locator('#environment-form');
    this.save = page.locator('#environment-save');
    this.saveBottom = page.locator('#environment-save-bottom');
    this.filter = page.locator('#setting-filter');
    this.errors = page.locator('#environment-errors');
    this.loadWarning = page.locator('#environment-error');
    this.empty = page.locator('#environment-empty');
    this.restartCard = page.locator('#restart-card');
    this.restart = page.locator('#restart-submit');
    this.confirmDialog = new ConfirmDialog(page);
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
    return this.page.locator('[data-group][data-group-name]');
  }

  rows(): Locator {
    return this.page.locator('tr[data-key]');
  }

  visibleRows(): Locator {
    return this.page.locator('tr[data-key]:not([hidden])');
  }

  row(key: string): Locator {
    return this.page.locator(`tr[data-key="${key}"]`);
  }

  input(key: string): Locator {
    return this.row(key).locator('input, textarea, mat-select').first();
  }

  error(key: string): Locator {
    return this.page.locator(`[data-setting-error="${key}"]`);
  }

  secretInputs(): Locator {
    return this.page.locator('tr[data-key] input[type="password"]');
  }

  secretStates(): Locator {
    return this.page.locator('tr[data-key] [data-secret-state]');
  }

  savedSetting(group: string, subGroupAndProperty: string): Locator {
    return this.page
      .locator('#environment-saved-copy [data-testid="saved-group"]')
      .filter({ has: this.page.locator('h5', { hasText: new RegExp(`^\\s*${group}\\s*$`) }) })
      .locator(`tr[data-saved-setting="${subGroupAndProperty}"]`);
  }
}

export class HostUsersPage {
  readonly members: Locator;
  readonly empty: Locator;
  readonly error: Locator;
  readonly search: Locator;
  readonly searchSubmit: Locator;
  readonly searchEmpty: Locator;
  readonly candidates: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.members = page.locator('#host-users-table tr[data-member]');
    this.empty = page.locator('#host-users-empty');
    this.error = page.locator('#host-users-error');
    this.search = page.locator('#host-user-search');
    this.searchSubmit = page.locator('#host-user-search-submit');
    this.searchEmpty = page.locator('#host-user-search-empty');
    this.candidates = page.locator('#candidates-table tr[data-candidate]');
    this.confirmDialog = new ConfirmDialog(page);
  }

  async open(uuid: string, search?: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${uuid}/users${search ? `?search=${encodeURIComponent(search)}` : ''}`);
    await expect(this.members.first().or(this.empty).or(this.error)).toBeVisible();
    if (search) {
      await expect(this.candidates.first().or(this.searchEmpty)).toBeVisible();
    }
    await waitForIdle(this.page);
  }

  member(email: string): Locator {
    return this.page.locator(`#host-users-table tr[data-member="${email}"]`);
  }

  candidate(email: string): Locator {
    return this.page.locator(`#candidates-table tr[data-candidate="${email}"]`);
  }

  async add(email: string, role: 'Driver' | 'HostUser'): Promise<void> {
    const row = this.candidate(email);
    await chooseOption(this.page, row.locator('[data-testid="candidate-role"]'), new RegExp(`^\\s*${role}\\s*$`));
    await row.locator('[data-testid="candidate-add"]').click();
  }

  async update(email: string, role: 'Driver' | 'HostUser', hostAdmin: boolean): Promise<void> {
    const row = this.member(email);
    await chooseOption(this.page, row.locator('[data-testid="member-role"]'), new RegExp(`^\\s*${role}\\s*$`));
    await this.hostAdmin(email).setChecked(hostAdmin);
    await row.locator('[data-testid="member-update"]').click();
  }

  async remove(email: string): Promise<void> {
    await this.member(email).locator('[data-testid="member-remove"]').click();
    await this.confirmDialog.accept();
  }

  role(email: string): Locator {
    return selectedText(this.member(email).locator('[data-testid="member-role"]'));
  }

  hostAdmin(email: string): Locator {
    return this.member(email).locator('[data-testid="member-host-admin"] input[type="checkbox"]');
  }

  memberLink(email: string): Locator {
    return this.member(email).locator('[data-testid="member-link"]');
  }
}

export class UserDetailPage {
  readonly state: Locator;
  readonly facts: Locator;
  readonly email: Locator;
  readonly platformRoles: Locator;
  readonly hosts: Locator;
  readonly hostsEmpty: Locator;
  readonly deactivate: Locator;
  readonly reactivate: Locator;
  readonly error: Locator;
  readonly confirmDialog: ConfirmDialog;

  constructor(private readonly page: Page) {
    this.state = page.locator('#account-state');
    this.facts = page.locator('#user-facts');
    this.email = page.locator('#user-email');
    this.platformRoles = page.locator('#user-platform-roles');
    this.hosts = page.locator('#user-hosts');
    this.hostsEmpty = page.locator('#user-hosts-empty');
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
