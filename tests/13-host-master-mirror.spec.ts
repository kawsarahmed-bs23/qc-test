import { test, expect } from '../fixtures/test';
import { canUseMasterDb, queryMasterDb } from '../fixtures/localDb';
import { HostEnvironmentPage, HostFeaturesPage } from '../pages/HostManagementPages';
import { env } from '../config/environment';

const UNREACHABLE_API = 'https://localhost:9';
const SAFE_SETTING = { group: 'DispatchSnapshot', property: 'RateLimitPermitsPerHour', key: 'DispatchSnapshot:RateLimitPermitsPerHour' };

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`;
}

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

  test('MIR-01 opening Features copies every product feature and MFA into HOST_MASTER', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);

    const keys = await features.featureKeys();
    const enabled = new Set(await features.enabledKeys());
    const mfaOn = await features.mfaOn();
    const id = hostId(targetHost.uuid);

    const expected: Record<string, boolean> = { mfa: mfaOn };
    for (const key of keys) {
      expected[key] = enabled.has(key);
    }

    expect(masterFeatures(id)).toEqual(expected);

    for (const area of ['Features', 'Mfa']) {
      const sync = lastSync(id, area);
      expect(sync.status, `${area} sync status`).toBe('Succeeded');
      expect(sync.ageSeconds, `${area} synced just now`).toBeLessThan(120);
    }
  });

  test('MIR-02 opening Environment copies every setting into HOST_MASTER, with no secret values', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);

    const pageRows = await environment.rows().count();
    const secretInputs = await environment.secretInputs().count();
    const shownValue = await environment.input(SAFE_SETTING.key).inputValue();
    const id = hostId(targetHost.uuid);

    expect(Number(queryMasterDb(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1`))).toBe(pageRows);
    expect(Number(queryMasterDb(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND IsSensitive = 1`))).toBe(secretInputs);
    expect(Number(queryMasterDb(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND IsSensitive = 1 AND PropertyValue IS NOT NULL`)), 'no secret value is stored').toBe(0);

    const stored = queryMasterDb(
      `SELECT PropertyValue FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND GroupName = N'${SAFE_SETTING.group}' AND SubGroupName IS NULL AND PropertyName = N'${SAFE_SETTING.property}'`,
    );
    expect(stored ?? '').toBe(shownValue);

    const sync = lastSync(id, 'Environment');
    expect(sync.status).toBe('Succeeded');
    expect(sync.ageSeconds).toBeLessThan(120);
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
      expect(queryMasterDb(`SELECT UpdatedBy FROM app.HostFeatures WHERE HostID_FK = ${id} AND Active = 1 AND FeatureKey = 'maps'`)).toBe(env.admin!.email);
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

  test('MIR-04 when the host API is unreachable, both pages show the HOST_MASTER copy read-only', { tag: '@write' }, async ({ page, targetHost }) => {
    test.setTimeout(120_000);
    const id = hostId(targetHost.uuid);
    const features = new HostFeaturesPage(page);
    const environment = new HostEnvironmentPage(page);

    await features.open(targetHost.uuid);
    await environment.open(targetHost.uuid);
    const saved = masterFeatures(id);
    const syncedBefore = lastSync(id, 'Features').syncedAt;
    const secretRows = Number(queryMasterDb(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND IsSensitive = 1`));
    const originalUrl = queryMasterDb(`SELECT ApiBaseUrl FROM app.Hosts WHERE HostID = ${id}`);
    const savedValue = queryMasterDb(
      `SELECT PropertyValue FROM app.HostEnvironmentSettings WHERE HostID_FK = ${id} AND Active = 1 AND GroupName = N'${SAFE_SETTING.group}' AND SubGroupName IS NULL AND PropertyName = N'${SAFE_SETTING.property}'`,
    );

    try {
      queryMasterDb(`UPDATE app.Hosts SET ApiBaseUrl = ${sqlText(UNREACHABLE_API)} WHERE HostID = ${id}`);

      await features.openUnreachable(targetHost.uuid);
      await expect(features.productError).toContainText('The host API could not be reached');
      await expect(features.save).toHaveCount(0);
      await expect(features.savedCopy).toContainText('Read-only');
      await expect(features.savedFeature('maps')).toContainText(saved.maps ? 'On' : 'Off');
      await expect(features.savedFeature('mfa')).toHaveCount(0);

      const failed = lastSync(id, 'Features');
      expect(failed.status).toBe('Failed');
      expect(failed.syncedAt, 'the last good sync time is kept').toBe(syncedBefore);
      expect(masterFeatures(id), 'a failed read changes no feature row').toEqual(saved);

      await environment.openUnreachable(targetHost.uuid);
      await expect(environment.loadWarning).toContainText('The host API could not be reached');
      await expect(environment.save).toHaveCount(0);
      await expect(environment.form).toHaveCount(0);
      await expect(page.locator('#environment-saved-copy input')).toHaveCount(0);
      await expect(environment.savedSetting(SAFE_SETTING.group, `:${SAFE_SETTING.property}`).locator('code')).toHaveText(savedValue ?? '');
      await expect(environment.savedCopy.getByText('Secret, not stored')).toHaveCount(secretRows);
    } finally {
      queryMasterDb(`UPDATE app.Hosts SET ApiBaseUrl = ${sqlText(originalUrl)} WHERE HostID = ${id}`);
    }

    await features.open(targetHost.uuid);
    expect(lastSync(id, 'Features').status).toBe('Succeeded');
    await environment.open(targetHost.uuid);
    expect(lastSync(id, 'Environment').status).toBe('Succeeded');
  });
});
