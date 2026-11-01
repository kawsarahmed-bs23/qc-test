import { test, expect } from '../fixtures/test';
import { canSeedLocalDb, canUseMasterDb, queryMasterDb, runMasterSeedScript } from '../fixtures/localDb';
import { UNREACHABLE_HOST_KEY, hostIdByKey, hostUuidByKey, recordCounts, secretsDifferingFromHost } from '../fixtures/environmentRecord';
import { HostEnvironmentPage, HostFeaturesPage } from '../pages/HostManagementPages';
import { adminAccount } from '../fixtures/throwawayUsers';

const SAFE_SETTING = { group: 'DispatchSnapshot', property: 'RateLimitPermitsPerHour', key: 'DispatchSnapshot:RateLimitPermitsPerHour' };

function hostId(uuid: string): number {
  const id = queryMasterDb(`SELECT HostID FROM app.Hosts WHERE HostUUID = '${uuid}'`);
  expect(id, `host ${uuid} in HOST_MASTER`).not.toBeNull();
  return Number(id);
}

function masterFeatures(id: number): Record<string, boolean> {
  const rows = queryMasterDb(
    `SELECT STRING_AGG(FeatureKey + '=' + CAST(IsEnabled AS varchar(1)), ',') FROM app.HostFeatures WHERE HostID_FK = ${id} AND Active = 1`,
  );
  return Object.fromEntries((rows ?? '').split(',').filter(Boolean).map((pair) => {
    const [key, flag] = pair.split('=');
    return [key, flag === '1'];
  }));
}

function lastSync(id: number, area: string): { status: string; ageSeconds: number; syncedAt: string } {
  const row = queryMasterDb(
    `SELECT LastStatus + '|' + CAST(DATEDIFF(second, LastSyncedAt, GETUTCDATE()) AS varchar(20)) + '|' + CONVERT(varchar(30), LastSyncedAt, 126) FROM app.HostSyncs WHERE HostID_FK = ${id} AND Area = N'${area}' AND Active = 1`,
  );
  expect(row, `HostSyncs row for ${area}`).not.toBeNull();
  const [status, age, syncedAt] = row!.split('|');
  return { status, ageSeconds: Number(age), syncedAt };
}

test.describe('HOST_MASTER copy of host features and environment (QC-737, Angular since QC-742)', () => {
  test.beforeEach(() => {
    test.skip(!canUseMasterDb(), 'Needs MASTER_SQL_DATABASE (local only).');
  });

  test('MIR-01 the Features page shows the HOST_MASTER value of every catalog feature, and opening it writes nothing to HOST_MASTER (QC-775)', async ({ page, targetHost }) => {
    const id = hostId(targetHost.uuid);
    const before = masterFeatures(id);
    const lastWrite = () => queryMasterDb(`SELECT CONVERT(varchar(30), MAX(Updated), 126) FROM app.HostFeatures WHERE HostID_FK = ${id}`);
    const writtenBefore = lastWrite();
    const syncedBefore = lastSync(id, 'Features').syncedAt;

    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const enabled = new Set(await features.enabledKeys());
    for (const key of await features.featureKeys()) {
      expect(enabled.has(key), key).toBe(before[key] ?? false);
    }
    expect(await features.mfaOn()).toBe(before.mfa ?? false);

    expect(masterFeatures(id)).toEqual(before);
    expect(lastWrite()).toBe(writtenBefore);
    expect(lastSync(id, 'Features').syncedAt, 'opening the page sends nothing').toBe(syncedBefore);
  });

  test('MIR-02 opening Environment reconciles HOST_MASTER with the host: every host row is recorded, secrets included, and the page shows the HOST_MASTER values (QC-744)', async ({ page, targetHost }) => {
    test.skip(!canSeedLocalDb(), 'Needs the host database to compare with (local only).');
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);

    const pageRows = await environment.rows().count();
    const secretInputs = await environment.secretInputs().count();
    const shownValue = await environment.input(SAFE_SETTING.key).inputValue();
    const id = hostId(targetHost.uuid);
    const counts = recordCounts(id);

    expect(counts.masterActive, 'every host row is in HOST_MASTER').toBe(counts.hostRows);
    expect(pageRows).toBe(counts.masterActive);
    expect(secretInputs).toBe(counts.masterSecrets);
    expect(counts.masterSecretsNull === 0, 'every secret is stored in HOST_MASTER').toBe(true);
    expect(secretsDifferingFromHost(id) === 0, 'each stored secret equals the host value').toBe(true);
    for (const secret of await environment.secretInputs().all()) {
      await expect(secret).toHaveValue('');
    }

    const stored = queryMasterDb(
      `SELECT PropertyValue FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND GroupName = N'${SAFE_SETTING.group}' AND SubGroupName IS NULL AND PropertyName = N'${SAFE_SETTING.property}'`,
    );
    expect(stored ?? '').toBe(shownValue);
    expect(await environment.field(SAFE_SETTING.key).getAttribute('data-setting-id')).toBe(
      queryMasterDb(`SELECT LOWER(CAST(HostEnvironmentSettingUUID AS varchar(36))) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND GroupName = N'${SAFE_SETTING.group}' AND SubGroupName IS NULL AND PropertyName = N'${SAFE_SETTING.property}'`),
    );
  });

  test('MIR-03 saving a feature updates HOST_MASTER with the Admin user as the changer', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('maps');
    const id = hostId(targetHost.uuid);

    try {
      await features.setOn('maps', !original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change.');

      expect(masterFeatures(id).maps).toBe(!original);
      expect(queryMasterDb(`SELECT UpdatedBy FROM app.HostFeatures WHERE HostID_FK = ${id} AND Active = 1 AND FeatureKey = 'maps'`)).toBe(adminAccount()!.email);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }

    expect(masterFeatures(id).maps).toBe(original);
  });

  test('MIR-04 when the host API is unreachable, Features still lists the HOST_MASTER values for editing with a warning, and Environment shows the HOST_MASTER values with Save off (QC-744)', { tag: '@write' }, async ({ page }) => {
    runMasterSeedScript('master-qc744-host.apply.sql');
    try {
      const uuid = hostUuidByKey(UNREACHABLE_HOST_KEY);
      const id = hostIdByKey(UNREACHABLE_HOST_KEY);
      const features = new HostFeaturesPage(page);
      const environment = new HostEnvironmentPage(page);
      const saved = masterFeatures(id);

      await features.open(uuid);
      await expect(features.hostError).toContainText('could not be reached');
      await expect(features.pending).toHaveCount(0);
      await expect(features.pendingBadges).toHaveCount(0);
      await expect(features.save).toBeEnabled();
      await expect(features.checkbox('maps')).toBeEnabled();
      await expect(features.checkbox('maps')).toBeChecked({ checked: saved.maps ?? false });
      await expect(features.feature('mfa')).toHaveCount(0);
      expect(queryMasterDb(`SELECT COUNT(*) FROM app.HostSyncs WHERE HostID_FK = ${id}`), 'reading an unreachable host records nothing').toBe('0');
      expect(masterFeatures(id), 'a failed read changes no feature row').toEqual(saved);

      await environment.openUnreachable(uuid);
      await expect(environment.loadWarning).toContainText('The host API could not be reached');
      await expect(environment.form).toBeVisible();
      await expect(environment.save).toBeDisabled();
      await expect(page.locator('#environment-saved-copy')).toHaveCount(0);
      await expect(environment.driftCard).toHaveCount(0);
      await environment.reveal(SAFE_SETTING.key);
      await expect(environment.input(SAFE_SETTING.key)).toHaveValue('60');
      await environment.reveal('E2E:ProbeSecret');
      await expect(environment.secretInputs()).toHaveCount(1);
      await expect(environment.secretInputs()).toHaveValue('');
      await expect(environment.hint('E2E:ProbeSecret')).toHaveText(/^\s*Set\s*$/);
      expect(await page.content()).not.toContain('e2e-qc744-made-up-secret');
    } finally {
      runMasterSeedScript('master-qc744-host.remove.sql');
    }
  });
});
