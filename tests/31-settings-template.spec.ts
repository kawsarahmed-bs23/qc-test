import { test, expect } from '@fixtures/pageFixtures';
import {
  canSeedLocalDb,
  canUseMasterDb,
  markChangeLogs,
  queryMasterDb,
  removeChangeLogsSince,
  runMasterSeedScript,
  runSeedScript,
  type ChangeLogMark,
} from '@utils/localDb';
import { hostIdByKey, hostUuidByKey, restoreEnvironmentSync, snapshotEnvironmentSync, type EnvironmentSyncSnapshot } from '@utils/environmentRecord';
import { featureCatalog, hostDbFeatureFlags, hostOrganisationId, masterFeatureFlags, masterHostId } from '@utils/featureSnapshot';
import { adminAccount } from '@utils/throwawayUsers';
import { AdminApi, canUseAdminApi } from '@api/admin.api';
import { HostEnvironmentPage, HostListPage } from '@pages/host-management.page';
import {
  HostReadinessCard,
  QC745_HOST_KEY_PREFIX,
  SettingTemplatePage,
  TEMPLATE_GROUP,
  TemplateApi,
  activeHostRows,
  activeTemplateCount,
  defaultEnabledKeys,
  environmentSettings,
  hostDbSchema,
  hostDbSettingCount,
  hostDbValue,
  hostReadyBadge,
  masterCount,
  masterHostValue,
  restoreFeatureDefaults,
  seedThrowawayOverride,
  settingResetDefault,
  settingSource,
  settingMissing,
  snapshotFeatureDefaults,
  syncCount,
  templateDbValue,
  templateKey,
  templateSettings,
  type FeatureDefaultsSnapshot,
} from '@pages/setting-template.page';

const SHARED = 'Shared';
const HOST_ONLY = 'HostOnly';
const SECRET = 'ProbeSecret';
const UI_PROBE = 'UiProbe';
const NEW_HOST_SHARED = 'NewHostShared';
const ORGANISATION_KEY = 'HostOrganisationId';

interface TargetSnapshot {
  targetId: number;
  environmentSync: EnvironmentSyncSnapshot;
  templateSyncs: number;
  mark: ChangeLogMark;
}

function cleanUp(): void {
  runMasterSeedScript('master-qc745.remove.sql');
  runSeedScript('host-qc745.remove.sql');
}

function snapshotTarget(uuid: string): TargetSnapshot {
  const targetId = masterHostId(uuid);
  return { targetId, environmentSync: snapshotEnvironmentSync(targetId), templateSyncs: syncCount(targetId, 'Template'), mark: markChangeLogs() };
}

function restoreTarget(snapshot: TargetSnapshot | undefined): void {
  cleanUp();
  if (!snapshot) return;
  restoreEnvironmentSync(snapshot.environmentSync);
  if (snapshot.templateSyncs === 0) {
    queryMasterDb(`DELETE app.HostSyncs WHERE HostID_FK = ${snapshot.targetId} AND Area = N'Template'`);
  }
  removeChangeLogsSince(snapshot.mark, adminAccount()!.email);
}

test.skip(!canUseMasterDb() || !canSeedLocalDb() || !canUseAdminApi(), 'Needs HOST_MASTER, the host database and the Admin API (local only).');

test.describe('Settings template on the ready target host (QC-745)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });

  let target: TargetSnapshot | undefined;
  let baseline: { templates: number; hostRows: number; hostDbRows: number; schema: string };

  test.beforeAll(({ targetHost }) => {
    cleanUp();
    target = snapshotTarget(targetHost.uuid);
    baseline = { templates: activeTemplateCount(), hostRows: activeHostRows(target.targetId), hostDbRows: hostDbSettingCount(), schema: hostDbSchema() };
    runMasterSeedScript('master-qc745-template.apply.sql');
  });

  test.afterAll(() => {
    restoreTarget(target);
  });

  test('TPL-01 the template lists every active key once: shared keys carry a default, host-specific keys none, and no secret is shown', async ({ request }) => {
    const view = await new TemplateApi(AdminApi.asAdmin(request)).view();
    const settings = templateSettings(view);

    expect(settings.length).toBe(activeTemplateCount());
    expect(new Set(settings.map((s) => s.settingUuid)).size).toBe(settings.length);
    expect(new Set(settings.map((s) => s.configurationKey.toUpperCase())).size).toBe(settings.length);
    for (const setting of settings) {
      if (setting.isHostSpecific) {
        expect(setting.value, `${setting.configurationKey} has no default`).toBeNull();
        expect(setting.overrideCount, setting.configurationKey).toBe(0);
      } else {
        expect(setting.isRequired, `${setting.configurationKey} required only when host-specific`).toBe(false);
        expect(setting.isSensitive, `${setting.configurationKey} a secret is never shared`).toBe(false);
      }
      if (setting.isSensitive) {
        expect(setting.value, `${setting.configurationKey} secret`).toBeNull();
        expect(setting.isHostSpecific, setting.configurationKey).toBe(true);
      }
    }
    expect(settings.find((s) => s.configurationKey === templateKey(SECRET))).toMatchObject({ isSensitive: true, isHostSpecific: true, value: null });

    expect(view.features.map((f) => f.key).sort()).toEqual(
      featureCatalog()
        .map((f) => f.key)
        .sort(),
    );
    expect(
      view.features
        .filter((f) => f.defaultEnabled)
        .map((f) => f.key)
        .sort(),
    ).toEqual(defaultEnabledKeys());
  });

  test('TPL-02 a host-specific key cannot get a default, a sensitive key cannot be made shared, and a duplicate key is refused; nothing changes', async ({
    request,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));

    const withValue = await tpl.addKey({ groupName: TEMPLATE_GROUP, propertyName: HOST_ONLY, isHostSpecific: true, value: 'not-allowed' });
    expect(withValue.status, withValue.text).toBe(400);
    expect(Object.keys(withValue.body.errors ?? {})).toContain('value');
    expect(templateDbValue(HOST_ONLY), 'nothing was added').toBeNull();

    const added = await tpl.addKey({
      groupName: TEMPLATE_GROUP,
      propertyName: HOST_ONLY,
      isHostSpecific: true,
      isRequired: false,
      description: 'E2E QC-745 probe',
    });
    expect(added.status, added.text).toBe(200);
    expect(added.body.pushes, 'a host-specific key is sent to nobody').toEqual([]);
    const hostOnly = (await tpl.setting(templateKey(HOST_ONLY)))!;
    expect(hostOnly).toMatchObject({ isHostSpecific: true, value: null, hasValue: false });

    const refused = await tpl.saveDefaults({ [hostOnly.settingUuid]: 'not-allowed' });
    expect(refused.status, refused.text).toBe(400);
    expect(Object.keys(refused.body.errors ?? {}).map((k) => k.toLowerCase())).toContain(hostOnly.settingUuid.toLowerCase());
    expect(templateDbValue(HOST_ONLY), 'the host-specific key still has no default').toBe('<null>');

    const secret = (await tpl.setting(templateKey(SECRET)))!;
    const shared = await tpl.setScope(secret.settingUuid, false, false);
    expect(shared.status, shared.text).toBe(400);
    expect(
      masterCount(`SELECT COUNT(*) FROM app.SettingTemplates WHERE SettingTemplateUUID = '${secret.settingUuid}' AND IsHostSpecific = 1 AND IsSensitive = 1`),
    ).toBe(1);

    const duplicate = await tpl.addKey({ groupName: TEMPLATE_GROUP, propertyName: HOST_ONLY, isHostSpecific: true });
    expect(duplicate.status, duplicate.text).toBe(400);
    expect(masterCount(`SELECT COUNT(*) FROM app.SettingTemplates WHERE GroupName = N'${TEMPLATE_GROUP}' AND PropertyName = N'${HOST_ONLY}'`)).toBe(1);
  });

  test('TPL-03 a shared key added to the template shows on the target host as its default, and the host API creates the row in the host database', async ({
    request,
    targetHost,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const hostDbBefore = hostDbSettingCount();

    const added = await tpl.addKey({ groupName: TEMPLATE_GROUP, propertyName: SHARED, value: 'tpl-a', description: 'E2E QC-745 probe' });
    expect(added.status, added.text).toBe(200);
    expect(added.body.pushes).toEqual([
      expect.objectContaining({ hostUuid: expect.stringMatching(new RegExp(targetHost.uuid, 'i')), succeeded: true, settingCount: 1 }),
    ]);

    expect(hostDbValue(SHARED), 'the host database got the new row').toBe('tpl-a');
    expect(hostDbSettingCount()).toBe(hostDbBefore + 1);
    expect(masterHostValue(target!.targetId, SHARED), 'HOST_MASTER keeps no host row for an inherited key').toBeNull();

    const template = (await tpl.setting(templateKey(SHARED)))!;
    const onHost = await tpl.environmentSetting(targetHost.uuid, templateKey(SHARED));
    expect(onHost).toMatchObject({
      settingUuid: template.settingUuid,
      source: 'default',
      value: 'tpl-a',
      defaultValue: 'tpl-a',
      isHostSpecific: false,
      missingOnHost: false,
      differsOnHost: false,
    });
  });

  test('TPL-04 changing a shared default reaches the target host when it inherits the key', async ({ request, targetHost }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const template = (await tpl.setting(templateKey(SHARED)))!;

    const saved = await tpl.saveDefaults({ [template.settingUuid]: 'tpl-b' });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.body.pushes).toEqual([expect.objectContaining({ hostName: targetHost.name, succeeded: true, settingCount: 1 })]);
    expect(templateDbValue(SHARED)).toBe('tpl-b');
    expect(hostDbValue(SHARED)).toBe('tpl-b');
    expect(await tpl.environmentSetting(targetHost.uuid, templateKey(SHARED))).toMatchObject({ source: 'default', value: 'tpl-b' });
  });

  test("TPL-05 a host's own value for a shared key survives a default change, and the template counts and names the overriding host", async ({
    request,
    targetHost,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    seedThrowawayOverride(target!.targetId, SHARED, 'host-own');
    expect(hostDbValue(SHARED)).toBe('host-own');
    expect(await tpl.environmentSetting(targetHost.uuid, templateKey(SHARED))).toMatchObject({
      source: 'override',
      value: 'host-own',
      defaultValue: 'tpl-b',
      differsOnHost: false,
    });

    const template = (await tpl.setting(templateKey(SHARED)))!;
    expect(template.overrideCount).toBeGreaterThanOrEqual(1);
    expect(template.overridingHosts).toContain(targetHost.name);

    const changed = await tpl.saveDefaults({ [template.settingUuid]: 'tpl-c' });
    expect(changed.status, changed.text).toBe(200);
    expect(
      changed.body.pushes.filter((p) => p.hostName === targetHost.name),
      'nothing is sent to a host that overrides the key',
    ).toEqual([]);
    expect(templateDbValue(SHARED)).toBe('tpl-c');
    expect(hostDbValue(SHARED), 'the override survives on the host').toBe('host-own');
    expect(masterHostValue(target!.targetId, SHARED)).toBe('host-own');
    expect(await tpl.environmentSetting(targetHost.uuid, templateKey(SHARED))).toMatchObject({ source: 'override', value: 'host-own', defaultValue: 'tpl-c' });
  });

  test('TPL-17 Use template default on the target host drops its override and sends the default to the host database', async ({ request, targetHost }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const view = await tpl.environment(targetHost.uuid);
    const resent = environmentSettings(view)
      .filter((s) => !s.configurationKey.startsWith(`${TEMPLATE_GROUP}:`) && (s.differsOnHost || (s.missingOnHost && s.hasValue)))
      .map((s) => `${s.configurationKey} (${s.source}${s.differsOnHost ? ', differs on host' : ''}${s.missingOnHost ? ', missing on host' : ''})`);
    test.skip(
      resent.length > 0,
      `A reset is an environment save, which also re-sends every target-host setting that differs from HOST_MASTER: ${resent.join('; ')}. Not run so the real settings stay as they are.`,
    );

    const template = (await tpl.setting(templateKey(SHARED)))!;
    const reset = await tpl.resetToDefault(targetHost.uuid, template.settingUuid);
    expect(reset.status, reset.text).toBe(200);
    expect(masterHostValue(target!.targetId, SHARED), 'the override row is gone').toBeNull();
    expect(hostDbValue(SHARED), 'the default was sent to the host').toBe('tpl-c');
    expect(await tpl.environmentSetting(targetHost.uuid, templateKey(SHARED))).toMatchObject({ source: 'default', value: 'tpl-c' });
    expect((await tpl.setting(templateKey(SHARED)))!.overridingHosts).not.toContain(targetHost.name);
  });

  test('TPL-06 the Settings template page lists the keys and saves a changed default that reaches the target host', async ({
    page,
    request,
    targetHost,
    shell,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const added = await tpl.addKey({ groupName: TEMPLATE_GROUP, propertyName: UI_PROBE, value: 'ui-a', description: 'E2E QC-745 probe' });
    expect(added.status, added.text).toBe(200);

    const template = new SettingTemplatePage(page);
    await template.open();
    await template.expandGroup(TEMPLATE_GROUP);
    await expect(template.row(templateKey(SECRET))).toBeVisible();
    await expect(template.hostSpecificBadge(templateKey(SECRET))).toBeVisible();
    await expect(template.makeShared(templateKey(SECRET)), 'a secret offers no Make shared').toHaveCount(0);
    await expect(template.input(templateKey(UI_PROBE))).toHaveValue('ui-a');
    await expect(template.save).toBeDisabled();

    await template.input(templateKey(UI_PROBE)).fill('ui-b');
    await expect(template.save).toHaveText(/Save defaults \(1\)/);
    await template.save.click();
    await shell.expectStatus(/Saved 1 default\./);
    await expect(template.push(targetHost.name)).toHaveAttribute('data-push-ok', 'true');

    expect(templateDbValue(UI_PROBE)).toBe('ui-b');
    expect(hostDbValue(UI_PROBE)).toBe('ui-b');
    await template.open();
    await template.expandGroup(TEMPLATE_GROUP);
    await expect(template.input(templateKey(UI_PROBE))).toHaveValue('ui-b');
  });

  test('TPL-07 the Environment page marks each setting with where its value comes from', async ({ page, request, targetHost }) => {
    const view = environmentSettings(await new TemplateApi(AdminApi.asAdmin(request)).environment(targetHost.uuid));
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);

    for (const key of [templateKey(SHARED), templateKey(SECRET), ORGANISATION_KEY]) {
      const expected = view.find((s) => s.configurationKey === key)!;
      await environment.reveal(key);
      await expect(settingSource(page, key), key).toHaveAttribute('data-source', expected.source);
    }
    await expect(settingSource(page, ORGANISATION_KEY)).toHaveAttribute('data-source', 'host-specific');
    await expect(settingSource(page, templateKey(UI_PROBE))).toHaveAttribute('data-source', 'default');
    await expect(settingResetDefault(page, templateKey(UI_PROBE)), 'an inherited key offers no reset').toHaveCount(0);
    const shared = view.find((s) => s.configurationKey === templateKey(SHARED))!;
    await expect(settingResetDefault(page, templateKey(SHARED)), 'only an override offers Use template default').toHaveCount(
      shared.source === 'override' ? 1 : 0,
    );
    for (const setting of view) {
      expect(['default', 'override', 'host-specific', 'not-in-template'], setting.configurationKey).toContain(setting.source);
    }
  });

  test('TPL-08 the target host shows as Ready on its page and in the hosts list, with no Mark ready button', async ({ page, request, targetHost }) => {
    const readiness = await new TemplateApi(AdminApi.asAdmin(request)).readiness(targetHost.uuid);
    expect(readiness).toMatchObject({ isReady: true, hasApiBaseUrl: true, canMarkReady: false });

    const card = new HostReadinessCard(page);
    await card.open(targetHost.uuid);
    await expect(card.root).toHaveAttribute('data-ready', 'true');
    await expect(card.root).toContainText('Ready');
    await expect(card.markReady).toHaveCount(0);

    const list = new HostListPage(page);
    await list.open();
    await expect(hostReadyBadge(page, targetHost.uuid)).toHaveText('Ready');
  });

  test('TPL-09 the host database schema is unchanged after the template pushes', async () => {
    expect(hostDbSchema()).toBe(baseline.schema);
    expect(baseline.schema).toContain('EnvironmentSetting.PropertyValue');
    expect(baseline.schema).toContain('HostFeatures.Enabled');
  });
});

test.describe('Admin creates a host from the template (QC-745)', { tag: '@create' }, () => {
  let target: TargetSnapshot | undefined;

  test.beforeAll(({ targetHost }) => {
    cleanUp();
    target = snapshotTarget(targetHost.uuid);
  });

  test.afterAll(() => {
    restoreTarget(target);
  });

  test('TPL-10 a host created through the Admin API starts not ready, with the feature defaults and its organisation id, and is sent nothing', async ({
    request,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const stamp = Date.now().toString(36);

    const created = await tpl.createHost({
      name: `E2E QC-745 Created ${stamp}`,
      hostKey: `${QC745_HOST_KEY_PREFIX}-created-${stamp}`,
      clientId: `${QC745_HOST_KEY_PREFIX}.created${stamp}`,
      databaseName: 'QuarryConnect_Dev',
      uiUrl: 'http://localhost:4297',
      apiBaseUrl: 'https://localhost:9/',
      hostOrganisationId: 99,
    });
    expect([200, 201], `POST /api/hosts: ${created.text}`).toContain(created.status);
    expect(created.body).toMatchObject({ isReady: false, readyAt: null });
    const id = masterHostId(String(created.body.hostUuid));

    const flags = masterFeatureFlags(id);
    expect(Object.keys(flags).sort()).toEqual(
      featureCatalog()
        .map((f) => f.key)
        .sort(),
    );
    expect(
      Object.entries(flags)
        .filter(([, on]) => on)
        .map(([key]) => key)
        .sort(),
    ).toEqual(defaultEnabledKeys());
    expect(activeHostRows(id), 'only the organisation id is stored').toBe(1);
    expect(masterHostValue(id, ORGANISATION_KEY, '(root)')).toBe('99');
    expect(queryMasterDb(`SELECT ReadyAt FROM app.Hosts WHERE HostID = ${id}`)).toBeNull();
    expect(syncCount(id), 'nothing was sent to the new host').toBe(0);
  });
});

test.describe('A new host that is not ready yet (QC-745)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });

  const withApi = { key: `${QC745_HOST_KEY_PREFIX}-new`, uuid: '', id: 0 };
  const noApi = { key: `${QC745_HOST_KEY_PREFIX}-noapi`, uuid: '', id: 0 };
  let target: TargetSnapshot | undefined;
  let features: FeatureDefaultsSnapshot | undefined;

  test.beforeAll(({ targetHost }) => {
    cleanUp();
    target = snapshotTarget(targetHost.uuid);
    features = snapshotFeatureDefaults();
    runMasterSeedScript('master-qc745-host.apply.sql');
    for (const host of [withApi, noApi]) {
      host.uuid = hostUuidByKey(host.key);
      host.id = hostIdByKey(host.key);
    }
  });

  test.afterAll(() => {
    if (features) restoreFeatureDefaults(features);
    restoreTarget(target);
  });

  test('TPL-11 a host that is not ready inherits every shared default, inherits no host-specific value but its organisation id, and is sent nothing', async ({
    request,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const template = templateSettings(await tpl.view());
    const view = await tpl.environment(withApi.uuid);
    expect(view.error).toBeNull();
    expect(view.notice).toContain('not marked ready');

    const settings = environmentSettings(view);
    for (const key of template) {
      const setting = settings.find((s) => s.settingUuid === key.settingUuid);
      expect(setting, `${key.configurationKey} is listed`).toBeDefined();
      expect(setting!.missingOnHost, `${key.configurationKey}: the host was not asked`).toBe(false);
      if (!key.isHostSpecific) {
        expect(setting, key.configurationKey).toMatchObject({ source: 'default', value: key.value, defaultValue: key.value });
      } else if (key.configurationKey === ORGANISATION_KEY) {
        expect(setting).toMatchObject({ source: 'host-specific', value: '99', hasValue: true });
      } else {
        expect(setting, `${key.configurationKey} inherits nothing`).toMatchObject({ source: 'host-specific', value: null, hasValue: false });
      }
    }
    expect(settings.filter((s) => s.source === 'not-in-template')).toEqual([]);

    expect((await tpl.environment(noApi.uuid)).notice).toContain('no API address');
    expect(syncCount(withApi.id), 'nothing was sent to the host').toBe(0);
  });

  test('TPL-12 readiness lists the required host-specific keys, and Mark ready is refused while any is blank or the host has no API address', async ({
    request,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const required = templateSettings(await tpl.view())
      .filter((s) => s.isHostSpecific && s.isRequired && s.configurationKey !== ORGANISATION_KEY)
      .map((s) => s.configurationKey)
      .sort();
    expect(required.length).toBeGreaterThan(0);

    const readiness = await tpl.readiness(withApi.uuid);
    expect(readiness).toMatchObject({ isReady: false, readyAt: null, hasApiBaseUrl: true, canMarkReady: false });
    expect(readiness.missing.map((m) => m.configurationKey).sort()).toEqual(required);

    const refused = await tpl.markReady(withApi.uuid);
    expect(refused.status, refused.text).toBe(400);
    expect(Object.keys(refused.body.errors ?? {}).map((k) => k.toLowerCase())).toContain(readiness.missing[0].settingUuid.toLowerCase());
    expect(queryMasterDb(`SELECT ReadyAt FROM app.Hosts WHERE HostID = ${withApi.id}`)).toBeNull();
    expect(syncCount(withApi.id)).toBe(0);

    const noApiReadiness = await tpl.readiness(noApi.uuid);
    expect(noApiReadiness).toMatchObject({ isReady: false, hasApiBaseUrl: false, canMarkReady: false });
    expect(noApiReadiness.reason).toContain('API');
    expect((await tpl.markReady(noApi.uuid)).status).toBe(400);
    expect(queryMasterDb(`SELECT ReadyAt FROM app.Hosts WHERE HostID = ${noApi.id}`)).toBeNull();
  });

  test('TPL-13 a shared key added to the template shows on every host as its default, and only the ready host is sent it', async ({ request, targetHost }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const added = await tpl.addKey({ groupName: TEMPLATE_GROUP, propertyName: NEW_HOST_SHARED, value: 'nh-a', description: 'E2E QC-745 probe' });
    expect(added.status, added.text).toBe(200);
    expect(added.body.pushes.map((p) => p.hostName)).toEqual([targetHost.name]);

    for (const uuid of [withApi.uuid, noApi.uuid, targetHost.uuid]) {
      expect(await tpl.environmentSetting(uuid, templateKey(NEW_HOST_SHARED)), uuid).toMatchObject({ source: 'default', value: 'nh-a' });
    }
    expect(hostDbValue(NEW_HOST_SHARED)).toBe('nh-a');
    expect(masterHostValue(withApi.id, NEW_HOST_SHARED)).toBeNull();
    expect(syncCount(withApi.id)).toBe(0);
  });

  test("TPL-14 a feature switched off on a host stays off when that feature's default changes, no existing host changes, and rule-breaking defaults are refused", async ({
    request,
    targetHost,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const original = defaultEnabledKeys();
    expect(original).not.toContain('reports');

    expect((await tpl.saveHostFeatures(noApi.uuid, [...original, 'reports'])).status).toBe(200);
    expect((await tpl.saveHostFeatures(noApi.uuid, original)).status).toBe(200);
    expect(masterFeatureFlags(noApi.id).reports).toBe(false);

    const targetId = masterHostId(targetHost.uuid);
    const targetBefore = masterFeatureFlags(targetId);
    const targetDbBefore = hostDbFeatureFlags(hostOrganisationId(targetHost.uuid));
    const withApiBefore = masterFeatureFlags(withApi.id);

    try {
      const saved = await tpl.saveFeatureDefaults([...original, 'reports']);
      expect(saved.status, saved.text).toBe(200);
      expect((await tpl.view()).features.find((f) => f.key === 'reports')!.defaultEnabled).toBe(true);

      expect(masterFeatureFlags(noApi.id).reports, 'the host keeps its feature off').toBe(false);
      expect(masterFeatureFlags(withApi.id)).toEqual(withApiBefore);
      expect(masterFeatureFlags(targetId)).toEqual(targetBefore);
      expect(hostDbFeatureFlags(hostOrganisationId(targetHost.uuid))).toEqual(targetDbBefore);

      expect((await tpl.saveFeatureDefaults(['dispatch_statewide'])).status, 'statewide dispatch needs dispatch').toBe(400);
      expect((await tpl.saveFeatureDefaults(['quickbooks', 'sage'])).status, 'QuickBooks and Sage exclude each other').toBe(400);
      expect(defaultEnabledKeys()).toEqual([...original, 'reports'].sort());
    } finally {
      expect((await tpl.saveFeatureDefaults(original)).status).toBe(200);
      expect(defaultEnabledKeys()).toEqual(original);
    }
  });

  test('TPL-15 a host that is not ready keeps an environment save and a reset in HOST_MASTER, drops an override equal to the default, and sends nothing', async ({
    request,
  }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const shared = (await tpl.setting(templateKey(NEW_HOST_SHARED)))!;

    const saved = await tpl.saveEnvironment(withApi.uuid, { [shared.settingUuid]: 'new-own' });
    expect(saved.status, saved.text).toBe(200);
    expect(saved.text).toContain('not marked ready');
    expect(masterHostValue(withApi.id, NEW_HOST_SHARED)).toBe('new-own');
    expect(await tpl.environmentSetting(withApi.uuid, templateKey(NEW_HOST_SHARED))).toMatchObject({
      source: 'override',
      value: 'new-own',
      defaultValue: 'nh-a',
    });
    expect((await tpl.setting(templateKey(NEW_HOST_SHARED)))!.overrideCount).toBe(1);

    const reset = await tpl.resetToDefault(withApi.uuid, shared.settingUuid);
    expect(reset.status, reset.text).toBe(200);
    expect(masterHostValue(withApi.id, NEW_HOST_SHARED), 'the override row is gone').toBeNull();
    expect(await tpl.environmentSetting(withApi.uuid, templateKey(NEW_HOST_SHARED))).toMatchObject({ source: 'default', value: 'nh-a' });

    expect((await tpl.saveEnvironment(withApi.uuid, { [shared.settingUuid]: 'new-own' })).status).toBe(200);
    const same = await tpl.saveEnvironment(withApi.uuid, { [shared.settingUuid]: 'nh-a' });
    expect(same.status, same.text).toBe(200);
    expect(masterHostValue(withApi.id, NEW_HOST_SHARED), 'saving the default value removes the override').toBeNull();
    expect(syncCount(withApi.id), 'no environment send was tried').toBe(0);
  });

  test('TPL-18 the not-ready host shows Not ready with its missing keys and a disabled Mark ready, the list says Setting up, and Environment marks missing values', async ({
    page,
    request,
    targetHost,
  }) => {
    const readiness = await new TemplateApi(AdminApi.asAdmin(request)).readiness(withApi.uuid);

    const card = new HostReadinessCard(page);
    await card.open(withApi.uuid);
    await expect(card.root).toHaveAttribute('data-ready', 'false');
    await expect(card.missing).toHaveCount(readiness.missing.length);
    await expect(card.missingItem(readiness.missing[0].configurationKey)).toBeVisible();
    await expect(card.markReady).toBeDisabled();

    const list = new HostListPage(page);
    await list.open();
    await expect(hostReadyBadge(page, withApi.uuid)).toHaveText('Setting up');
    await expect(hostReadyBadge(page, targetHost.uuid)).toHaveText('Ready');

    const environment = new HostEnvironmentPage(page);
    await environment.open(withApi.uuid);
    const missingKey = readiness.missing[0].configurationKey;
    await environment.reveal(missingKey);
    await expect(settingSource(page, missingKey)).toHaveAttribute('data-source', 'host-specific');
    await expect(settingMissing(page, missingKey)).toBeVisible();
    await environment.reveal(ORGANISATION_KEY);
    await expect(settingMissing(page, ORGANISATION_KEY)).toHaveCount(0);
    await environment.reveal(templateKey(NEW_HOST_SHARED));
    await expect(settingSource(page, templateKey(NEW_HOST_SHARED))).toHaveAttribute('data-source', 'default');
  });

  test('TPL-16 a host that is not ready but has an API address keeps a feature save in HOST_MASTER and calls nothing', async ({ request }) => {
    const tpl = new TemplateApi(AdminApi.asAdmin(request));
    const enabled = Object.entries(masterFeatureFlags(withApi.id))
      .filter(([, on]) => on)
      .map(([key]) => key);

    const saved = await tpl.saveHostFeatures(withApi.uuid, [...enabled, 'reports']);
    expect(saved.status, `feature save on a host that is not ready: ${saved.text}`).toBe(200);
    expect(saved.text, 'the message says the features wait for Mark ready').toContain('sent to the host when it is marked ready');
    expect(masterFeatureFlags(withApi.id).reports).toBe(true);
    expect(syncCount(withApi.id), 'no feature send was tried').toBe(0);
  });
});
