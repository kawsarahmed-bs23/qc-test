import { expect, type Locator, type Page } from '@playwright/test';
import { querySingleValue, queryMasterDb } from '@utils/localDb';
import { sqlText } from '@utils/environmentRecord';
import type { AdminApi, AdminApiResult } from '@api/admin.api';
import { openAdmin, waitForIdle } from '@pages/admin-shell.page';

export const TEMPLATE_GROUP = 'E2EQC745';
export const QC745_HOST_KEY_PREFIX = 'e2e-qc745';

export interface TemplateSetting {
  settingUuid: string;
  groupName: string;
  subGroupName: string | null;
  propertyName: string;
  configurationKey: string;
  value: string | null;
  hasValue: boolean;
  propertyType: string;
  isSensitive: boolean;
  isRestartRequired: boolean;
  isHostSpecific: boolean;
  isRequired: boolean;
  description: string | null;
  overrideCount: number;
  overridingHosts: string[];
}

export interface TemplateFeature {
  key: string;
  label: string;
  defaultEnabled: boolean;
}

export interface TemplateView {
  groups: { groupName: string; settings: TemplateSetting[] }[];
  features: TemplateFeature[];
  hostSyncs: { hostUuid: string; hostName: string; status: string; lastError: string | null }[];
}

export interface TemplatePush {
  hostUuid: string;
  hostName: string;
  succeeded: boolean;
  settingCount: number;
  error: string | null;
}

export interface HostEnvironmentSettingJson {
  settingUuid: string;
  configurationKey: string;
  value: string | null;
  hasValue: boolean;
  isSensitive: boolean;
  source: 'default' | 'override' | 'host-specific' | 'not-in-template';
  isHostSpecific: boolean;
  isRequired: boolean;
  defaultValue: string | null;
  missingOnHost: boolean;
  differsOnHost: boolean;
}

export interface HostEnvironmentJson {
  groups: { groupName: string; settings: HostEnvironmentSettingJson[] }[];
  error: string | null;
  notice: string | null;
  canSave: boolean;
  driftCount: number;
}

export interface ReadinessJson {
  isReady: boolean;
  readyAt: string | null;
  hasApiBaseUrl: boolean;
  missing: { settingUuid: string; configurationKey: string }[];
  canMarkReady: boolean;
  reason: string | null;
}

export interface NewTemplateKey {
  groupName: string;
  subGroupName?: string | null;
  propertyName: string;
  value?: string | null;
  propertyType?: string;
  isRestartRequired?: boolean;
  isHostSpecific?: boolean;
  isRequired?: boolean;
  description?: string | null;
}

export interface NewHostInput {
  name: string;
  hostKey: string;
  clientId: string;
  databaseName: string;
  uiUrl: string;
  apiBaseUrl: string | null;
  hostOrganisationId: number;
}

export function templateSettings(view: TemplateView): TemplateSetting[] {
  return view.groups.flatMap((group) => group.settings);
}

export function environmentSettings(view: HostEnvironmentJson): HostEnvironmentSettingJson[] {
  return view.groups.flatMap((group) => group.settings);
}

export function templateKey(name: string): string {
  return `${TEMPLATE_GROUP}:${name}`;
}

export class TemplateApi {
  constructor(private readonly api: AdminApi) {}

  async view(): Promise<TemplateView> {
    const result = await this.api.get<TemplateView>('/templates');
    expect(result.status, result.text).toBe(200);
    return result.body;
  }

  async setting(configurationKey: string): Promise<TemplateSetting | undefined> {
    return templateSettings(await this.view()).find((s) => s.configurationKey === configurationKey);
  }

  saveDefaults(values: Record<string, string>): Promise<AdminApiResult<{ message: string; pushes: TemplatePush[]; errors?: Record<string, unknown> }>> {
    return this.api.put('/templates/settings', { values });
  }

  addKey(input: NewTemplateKey): Promise<AdminApiResult<{ message: string; pushes: TemplatePush[]; errors?: Record<string, unknown> }>> {
    return this.api.post('/templates/settings', { propertyType: 'string', isRestartRequired: false, isHostSpecific: false, isRequired: false, ...input });
  }

  setScope(settingUuid: string, isHostSpecific: boolean, isRequired: boolean): Promise<AdminApiResult> {
    return this.api.put(`/templates/settings/${settingUuid}/scope`, { isHostSpecific, isRequired });
  }

  saveFeatureDefaults(enabled: string[]): Promise<AdminApiResult> {
    return this.api.put('/templates/features', { enabled });
  }

  async environment(hostUuid: string): Promise<HostEnvironmentJson> {
    const result = await this.api.get<HostEnvironmentJson>(`/hosts/${hostUuid}/environment`);
    expect(result.status, result.text).toBe(200);
    return result.body;
  }

  async environmentSetting(hostUuid: string, configurationKey: string): Promise<HostEnvironmentSettingJson | undefined> {
    return environmentSettings(await this.environment(hostUuid)).find((s) => s.configurationKey === configurationKey);
  }

  saveEnvironment(hostUuid: string, values: Record<string, string>): Promise<AdminApiResult> {
    return this.api.put(`/hosts/${hostUuid}/environment`, { values, secrets: {} });
  }

  resetToDefault(hostUuid: string, settingUuid: string): Promise<AdminApiResult> {
    return this.api.post(`/hosts/${hostUuid}/environment/${settingUuid}/reset`);
  }

  async readiness(hostUuid: string): Promise<ReadinessJson> {
    const result = await this.api.get<ReadinessJson>(`/hosts/${hostUuid}/readiness`);
    expect(result.status, result.text).toBe(200);
    return result.body;
  }

  markReady(hostUuid: string): Promise<AdminApiResult> {
    return this.api.post(`/hosts/${hostUuid}/ready`);
  }

  saveHostFeatures(hostUuid: string, enabled: string[]): Promise<AdminApiResult> {
    return this.api.put(`/hosts/${hostUuid}/features/product`, { enabled });
  }

  createHost(input: NewHostInput): Promise<AdminApiResult> {
    return this.api.post('/hosts', input);
  }
}

export class SettingTemplatePage {
  readonly root: Locator;
  readonly accordion: Locator;
  readonly save: Locator;
  readonly pushes: Locator;
  readonly hostSyncs: Locator;
  readonly features: Locator;
  readonly featuresSave: Locator;
  readonly addGroup: Locator;
  readonly addName: Locator;
  readonly addValue: Locator;
  readonly addSave: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('#template-page');
    this.accordion = page.locator('#template-accordion');
    this.save = page.locator('#template-save');
    this.pushes = page.locator('#template-pushes');
    this.hostSyncs = page.locator('#template-host-syncs');
    this.features = page.locator('#template-features');
    this.featuresSave = page.locator('#template-features-save');
    this.addGroup = page.locator('#template-add-group');
    this.addName = page.locator('#template-add-name');
    this.addValue = page.locator('#template-add-value');
    this.addSave = page.locator('#template-add-save');
  }

  async open(): Promise<void> {
    await openAdmin(this.page, '/templates');
    await expect(this.accordion).toBeVisible();
    await waitForIdle(this.page);
  }

  group(name: string): Locator {
    return this.page.locator(`mat-expansion-panel[data-template-group="${name}"]`);
  }

  async expandGroup(name: string): Promise<void> {
    const header = this.group(name).locator('mat-expansion-panel-header');
    if ((await header.getAttribute('aria-expanded')) !== 'true') {
      await header.click();
    }
    await expect(header).toHaveAttribute('aria-expanded', 'true');
  }

  row(configurationKey: string): Locator {
    return this.page.locator(`[data-template-key="${configurationKey}"]`);
  }

  input(configurationKey: string): Locator {
    return this.page.locator(
      `#template-${configurationKey
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')}`,
    );
  }

  hostSpecificBadge(configurationKey: string): Locator {
    return this.row(configurationKey).locator('[data-testid="template-host-specific"]');
  }

  makeShared(configurationKey: string): Locator {
    return this.page.locator(`[data-template-make-shared="${configurationKey}"]`);
  }

  push(hostName: string): Locator {
    return this.pushes.locator(`li[data-push-host="${hostName}"]`);
  }

  feature(key: string): Locator {
    return this.page.locator(`#template-feature-${key}`);
  }
}

export function settingSource(page: Page, configurationKey: string): Locator {
  return page.locator(`[data-setting-id][data-key="${configurationKey}"] [data-testid="setting-source"]`);
}

export function settingMissing(page: Page, configurationKey: string): Locator {
  return page.locator(`[data-setting-id][data-key="${configurationKey}"] [data-testid="setting-missing"]`);
}

export function settingResetDefault(page: Page, configurationKey: string): Locator {
  return page.locator(`[data-setting-id][data-key="${configurationKey}"] [data-testid="setting-reset-default"]`);
}

export class HostReadinessCard {
  readonly root: Locator;
  readonly missing: Locator;
  readonly markReady: Locator;
  readonly reason: Locator;

  constructor(private readonly page: Page) {
    this.root = page.locator('#host-readiness');
    this.missing = page.locator('#host-readiness [data-testid="readiness-missing"]');
    this.markReady = page.locator('#host-mark-ready');
    this.reason = page.locator('#host-readiness-reason');
  }

  async open(hostUuid: string): Promise<void> {
    await openAdmin(this.page, `/hosts/${hostUuid}`);
    await expect(this.root).toBeVisible();
    await waitForIdle(this.page);
  }

  missingItem(configurationKey: string): Locator {
    return this.page.locator(`#host-readiness [data-testid="readiness-missing"][data-key="${configurationKey}"]`);
  }
}

export function hostReadyBadge(page: Page, hostUuid: string): Locator {
  return page.locator(`#hosts-table tr[data-host-uuid="${hostUuid}" i] [data-testid="host-ready"]`);
}

export function masterCount(sql: string): number {
  return Number(queryMasterDb(sql) ?? '0');
}

export function activeTemplateCount(): number {
  return masterCount('SELECT COUNT(*) FROM app.SettingTemplates WHERE Active = 1');
}

export function activeHostRows(hostId: number): number {
  return masterCount(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${hostId} AND Active = 1`);
}

export function masterHostValue(hostId: number, propertyName: string, groupName = TEMPLATE_GROUP): string | null {
  return queryMasterDb(
    `SELECT ISNULL(PropertyValue, N'<null>') FROM app.HostEnvironmentSettings WHERE HostID_FK = ${hostId} AND Active = 1 AND GroupName = ${sqlText(groupName)} AND PropertyName = ${sqlText(propertyName)}`,
  );
}

export function templateDbValue(propertyName: string): string | null {
  return queryMasterDb(
    `SELECT ISNULL(PropertyValue, N'<null>') FROM app.SettingTemplates WHERE Active = 1 AND GroupName = N'${TEMPLATE_GROUP}' AND PropertyName = ${sqlText(propertyName)}`,
  );
}

export function hostDbSettingCount(): number {
  return Number(querySingleValue('SELECT COUNT(*) FROM app.EnvironmentSetting') ?? '0');
}

export function hostDbValue(propertyName: string): string | null {
  return querySingleValue(`SELECT PropertyValue FROM app.EnvironmentSetting WHERE GroupName = '${TEMPLATE_GROUP}' AND PropertyName = ${sqlText(propertyName)}`);
}

export function seedThrowawayOverride(hostId: number, propertyName: string, value: string): void {
  queryMasterDb(
    `INSERT app.HostEnvironmentSettings (HostID_FK, GroupName, SubGroupName, PropertyName, PropertyValue, PropertyType, IsSensitive, IsRestartRequired, Description, CreatedBy, UpdatedBy) ` +
      `VALUES (${hostId}, N'${TEMPLATE_GROUP}', NULL, ${sqlText(propertyName)}, ${sqlText(value)}, N'string', 0, 0, N'E2E QC-745 probe', N'e2e', N'e2e')`,
  );
  querySingleValue(
    `UPDATE app.EnvironmentSetting SET PropertyValue = ${sqlText(value)} WHERE GroupName = '${TEMPLATE_GROUP}' AND PropertyName = ${sqlText(propertyName)}`,
  );
}

export function hostDbSchema(): string {
  return (
    querySingleValue(
      "SELECT STRING_AGG(CONCAT(OBJECT_NAME(c.object_id), '.', c.name, ':', t.name, ':', c.max_length, ':', c.is_nullable), ',') WITHIN GROUP (ORDER BY OBJECT_NAME(c.object_id), c.column_id) " +
        "FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id WHERE c.object_id IN (OBJECT_ID('app.EnvironmentSetting'), OBJECT_ID('app.HostFeatures'))",
    ) ?? ''
  );
}

export function syncCount(hostId: number, area?: string): number {
  return masterCount(`SELECT COUNT(*) FROM app.HostSyncs WHERE HostID_FK = ${hostId}${area ? ` AND Area = N'${area}'` : ''}`);
}

export function defaultEnabledKeys(): string[] {
  return (queryMasterDb('SELECT FeatureKey FROM app.Features WHERE Active = 1 AND DefaultEnabled = 1 ORDER BY FeatureKey') ?? '')
    .split(/\r?\n/)
    .filter(Boolean);
}

export interface FeatureDefaultsSnapshot {
  rows: string[];
}

export function snapshotFeatureDefaults(): FeatureDefaultsSnapshot {
  const rows = queryMasterDb(
    "SELECT FeatureKey + '|' + CAST(DefaultEnabled AS varchar(1)) + '|' + CONVERT(varchar(30), Updated, 126) + '|' + ISNULL(UpdatedBy, N'<null>') FROM app.Features WHERE Active = 1",
  );
  return { rows: (rows ?? '').split(/\r?\n/).filter(Boolean) };
}

export function restoreFeatureDefaults(snapshot: FeatureDefaultsSnapshot): void {
  for (const row of snapshot.rows) {
    const [key, flag, updated, by] = row.split('|');
    queryMasterDb(
      `UPDATE app.Features SET DefaultEnabled = ${flag}, Updated = '${updated}', UpdatedBy = ${by === '<null>' ? 'NULL' : sqlText(by)} WHERE FeatureKey = ${sqlText(key)} AND Active = 1 AND (DefaultEnabled <> ${flag} OR Updated <> '${updated}')`,
    );
  }
}
