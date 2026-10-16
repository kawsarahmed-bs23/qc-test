import { expect, type Locator, type Page } from '@playwright/test';

export type HostField = 'Name' | 'HostKey' | 'ClientId' | 'DatabaseName' | 'HostOrganisationId' | 'UiUrl' | 'ApiBaseUrl';

export interface NewHost {
  name: string;
  hostKey: string;
  clientId: string;
  databaseName: string;
  organisationId: string;
  uiUrl: string;
  apiBaseUrl?: string;
}

export class HostListPage {
  readonly table: Locator;
  readonly add: Locator;

  constructor(private readonly page: Page) {
    this.table = page.locator('#hosts-table');
    this.add = page.locator('#host-add');
  }

  async open(): Promise<void> {
    await this.page.goto('/hosts');
    await expect(this.page.locator('#page-heading')).toHaveText('Hosts');
  }

  row(uuid: string): Locator {
    return this.page.locator(`#hosts-table tr[data-host-uuid="${uuid}"]`);
  }
}

export class HostFormPage {
  readonly create: Locator;
  readonly save: Locator;
  readonly linkSelect: Locator;
  readonly identityPanel: Locator;
  readonly deactivateSummary: Locator;
  readonly deactivateConfirm: Locator;
  readonly deactivate: Locator;

  constructor(private readonly page: Page) {
    this.create = page.locator('#host-create');
    this.save = page.locator('#host-save');
    this.linkSelect = page.locator('#Input_IdentityHostId');
    this.identityPanel = page.locator('#identity-panel');
    this.deactivateSummary = page.locator('.danger-zone summary');
    this.deactivateConfirm = page.locator('input[name="ConfirmDeactivate"]');
    this.deactivate = page.locator('#host-deactivate');
  }

  async openNew(): Promise<void> {
    await this.page.goto('/hosts/new');
    await expect(this.page.locator('#page-heading')).toHaveText('Add host');
  }

  async openDetail(uuid: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}`);
    await expect(this.page.locator('#page-heading')).toBeVisible();
  }

  field(name: HostField): Locator {
    return this.page.locator(`#Input_${name}`);
  }

  error(name: HostField | 'IdentityHostId'): Locator {
    return this.page.locator(`[data-field-error="${name}"]`);
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

  async submitWithoutBrowserChecks(button: Locator): Promise<void> {
    await this.page.locator('form').filter({ has: button }).evaluate((form: HTMLFormElement) => (form.noValidate = true));
    await button.click();
  }
}

export class HostFeaturesPage {
  readonly save: Locator;
  readonly errors: Locator;
  readonly mfa: Locator;
  readonly mfaSave: Locator;

  constructor(private readonly page: Page) {
    this.save = page.locator('#features-save');
    this.errors = page.locator('#feature-errors');
    this.mfa = page.locator('#mfa-enabled');
    this.mfaSave = page.locator('#mfa-save');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}/features`);
    await expect(this.save).toBeVisible();
  }

  async openUnreachable(uuid: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}/features`);
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
    return this.page.locator(`#product-features input[data-feature="${key}"]`);
  }

  async enabledKeys(): Promise<string[]> {
    return this.page.locator('#product-features input[data-feature]:checked').evaluateAll((boxes) =>
      boxes.map((box) => (box as HTMLInputElement).dataset.feature!),
    );
  }

  async postDirect(uuid: string, enabled: string[]): Promise<{ status: number; html: string }> {
    const token = await this.page.locator('#product-features input[name="__RequestVerificationToken"]').inputValue();
    const body = new URLSearchParams();
    body.append('__RequestVerificationToken', token);
    for (const key of enabled) {
      body.append('Enabled', key);
    }

    const response = await this.page.request.post(`/hosts/${uuid}/features?handler=product`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body.toString(),
      maxRedirects: 0,
    });
    return { status: response.status(), html: await response.text() };
  }
}

export class HostEnvironmentPage {
  readonly save: Locator;
  readonly restartSummary: Locator;
  readonly restartConfirm: Locator;
  readonly restart: Locator;

  constructor(private readonly page: Page) {
    this.save = page.locator('#environment-save');
    this.restartSummary = page.locator('.danger-zone summary');
    this.restartConfirm = page.locator('#restart-confirm');
    this.restart = page.locator('#restart-submit');
  }

  async open(uuid: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}/environment`);
    await expect(this.save).toBeVisible();
  }

  async openUnreachable(uuid: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}/environment`);
    await expect(this.savedCopy).toBeVisible();
  }

  get savedCopy(): Locator {
    return this.page.locator('#environment-saved-copy');
  }

  rows(): Locator {
    return this.page.locator('tr[data-key]');
  }

  row(key: string): Locator {
    return this.page.locator(`tr[data-key="${key}"]`);
  }

  input(key: string): Locator {
    return this.row(key).locator('input, select, textarea').first();
  }

  error(key: string): Locator {
    return this.page.locator(`[data-setting-error="${key}"]`);
  }

  secretInputs(): Locator {
    return this.page.locator('input[name^="Secrets["]');
  }
}

export class HostUsersPage {
  constructor(private readonly page: Page) {}

  async open(uuid: string, search?: string): Promise<void> {
    await this.page.goto(`/hosts/${uuid}/users${search ? `?search=${encodeURIComponent(search)}` : ''}`);
    await expect(this.page.locator('#page-heading')).toBeVisible();
  }

  member(email: string): Locator {
    return this.page.locator(`tr[data-member="${email}"]`);
  }

  candidate(email: string): Locator {
    return this.page.locator(`tr[data-candidate="${email}"]`);
  }

  async add(email: string, role: 'Driver' | 'HostUser'): Promise<void> {
    const row = this.candidate(email);
    await row.locator('select[name="Role"]').selectOption(role);
    await row.getByRole('button', { name: /^Add to / }).click();
  }

  async update(email: string, role: 'Driver' | 'HostUser', hostAdmin: boolean): Promise<void> {
    const row = this.member(email);
    await row.locator('select[name="Role"]').selectOption(role);
    await row.locator('input[type="checkbox"][name="IsHostAdmin"]').setChecked(hostAdmin);
    await row.getByRole('button', { name: 'Update' }).click();
  }

  async remove(email: string): Promise<void> {
    const row = this.member(email);
    await row.locator('summary').click();
    await row.locator('input[name="ConfirmRemove"]').check();
    await row.getByRole('button', { name: 'Remove from this host' }).click();
  }

  role(email: string): Locator {
    return this.member(email).locator('select[name="Role"]');
  }

  hostAdmin(email: string): Locator {
    return this.member(email).locator('input[type="checkbox"][name="IsHostAdmin"]');
  }
}

export class UserDetailPage {
  readonly state: Locator;
  readonly hosts: Locator;

  constructor(private readonly page: Page) {
    this.state = page.locator('#account-state');
    this.hosts = page.locator('#user-hosts');
  }

  async setActive(active: boolean): Promise<void> {
    await this.page.locator('.danger-zone summary').click();
    await this.page.locator('input[name="ConfirmAccountChange"]').check();
    await this.page.locator(active ? '#account-reactivate' : '#account-deactivate').click();
  }
}
