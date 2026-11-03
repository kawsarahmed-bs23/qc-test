import { test, expect } from '../fixtures/test';
import { canSeedLocalDb, canUseIdentityDb, canUseMasterDb, markChangeLogs, queryMasterDb, removeChangeLogsSince, runMasterSeedScript, type ChangeLogMark } from '../fixtures/localDb';
import { featuresSync, masterFeatureFlags, masterHostId } from '../fixtures/featureSnapshot';
import {
  NO_API_HOST_KEY,
  UNREACHABLE_HOST_KEY,
  hostIdByKey,
  hostSecretHashes,
  hostStamp,
  hostUuidByKey,
  hostValue,
  masterStamp,
  masterUuid,
  masterValue,
  recordCounts,
  restoreEnvironmentSync,
  restoreSettingRows,
  secretsDifferingFromHost,
  setHostValue,
  settingsOf,
  snapshotEnvironmentSync,
  snapshotSettingRows,
  secretsFoundIn,
  type EnvironmentSyncSnapshot,
  type SettingRowSnapshot,
} from '../fixtures/environmentRecord';
import { adminAccount } from '../fixtures/throwawayUsers';
import { AdminApi, canUseAdminApi } from '../pages/AdminApi';
import { hostAppAccessToken, hostEnvironmentSettings, removeHostSuperAdmins, seedHostSuperAdmin } from '../pages/HostEnvironmentApi';
import { HostEnvironmentPage, HostFeaturesPage } from '../pages/HostManagementPages';
import { removeSuperAdminRole, seedSuperAdminRole } from '../pages/HostRootRemoved';
import { env } from '../config/environment';

const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';
const PUSH_SETTING = 'DriverLocation:IdleIntervalSeconds';
const TAKE_SETTING = 'DriverLocation:MovingIntervalSeconds';
const NO_API_SETTING = 'Jobs:ExpiryGraceDays';
const VIEW_KEYS = ['groups', 'error', 'notice', 'canSave', 'driftCount', 'lastPushedAt'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function changeLogsFor(hostId: number, since: ChangeLogMark): number {
  return Number(queryMasterDb(`SELECT COUNT(*) FROM app.ChangeLogs WHERE HostID_FK = ${hostId} AND ChangeLogID > ${since.lastId}`));
}

function probeFor(original: string | null, a: string, b: string): string {
  return original === a ? b : a;
}

test.describe('HOST_MASTER is the record for host environment settings (QC-744)', { tag: '@write' }, () => {
  test.skip(!canUseMasterDb() || !canSeedLocalDb(), 'Needs HOST_MASTER and the host database (local only).');

  let targetId: number;
  let rows: SettingRowSnapshot[];
  let sync: EnvironmentSyncSnapshot;
  let mark: ChangeLogMark;

  test.beforeAll(({ targetHost }) => {
    targetId = masterHostId(targetHost.uuid);
    rows = snapshotSettingRows(targetId, [SAFE_SETTING, PUSH_SETTING, TAKE_SETTING]);
    sync = snapshotEnvironmentSync(targetId);
    mark = markChangeLogs();
    runMasterSeedScript('master-qc744-host.apply.sql');
  });

  test.afterAll(() => {
    runMasterSeedScript('master-qc744-host.remove.sql');
    if (rows) restoreSettingRows(targetId, rows.filter((row) => row.master !== null));
    if (sync) restoreEnvironmentSync(sync);
    if (mark) removeChangeLogsSince(mark, adminAccount()!.email);
  });

  test('REC-01 opening Environment takes host-only rows and missing secrets into HOST_MASTER, and neither the page nor the Admin API shows a secret', async ({ page, request, targetHost }) => {
    const before = recordCounts(targetId);
    test.info().annotations.push({
      type: 'before-open',
      description: `HOST_MASTER active=${before.masterActive} secretsNull=${before.masterSecretsNull} messaging=${before.masterMessaging}; host rows=${before.hostRows} secrets=${before.hostSecrets} messaging=${before.hostMessaging}`,
    });

    const environment = new HostEnvironmentPage(page);
    const loaded = page.waitForResponse((response) => response.request().method() === 'GET' && /\/api\/hosts\/[^/]+\/environment$/.test(response.url()));
    await environment.open(targetHost.uuid);
    const pageView = await (await loaded).json();

    const after = recordCounts(targetId);
    test.info().annotations.push({
      type: 'after-open',
      description: `HOST_MASTER active=${after.masterActive} secretsNull=${after.masterSecretsNull} messaging=${after.masterMessaging}; secrets matching host=${secretsDifferingFromHost(targetId) === 0}`,
    });
    expect(after.masterActive, 'every host row is in HOST_MASTER').toBe(after.hostRows);
    expect(after.masterMessaging, 'the host-only Messaging rows were taken').toBe(after.hostMessaging);
    expect(after.masterSecrets).toBe(after.hostSecrets);
    expect(after.masterSecretsNull === 0, 'every secret is stored in HOST_MASTER').toBe(true);
    expect(secretsDifferingFromHost(targetId) === 0, 'each stored secret equals the host value').toBe(true);
    if (before.masterActive < before.hostRows) {
      expect(after.masterActive - before.masterActive, 'rows imported by this open').toBe(before.hostRows - before.masterActive);
    }
    expect(Number(queryMasterDb(`SELECT COUNT(*) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${targetId} AND Active = 1 AND GroupName = N'Messaging' AND CreatedBy <> N'admin.sync'`))).toBe(0);

    expect(await environment.rows().count()).toBe(after.masterActive);
    expect(await environment.secretInputs().count()).toBe(after.masterSecrets);
    for (const secret of await environment.secretInputs().all()) {
      await expect(secret).toHaveValue('');
    }
    await expect(page.locator('#environment-saved-copy')).toHaveCount(0);

    const secretHashes = hostSecretHashes();
    expect(secretHashes.length).toBeGreaterThan(0);
    const shownOnPage = await page.evaluate(() => {
      const texts: string[] = [];
      document.querySelectorAll('input, textarea').forEach((el) => texts.push((el as HTMLInputElement).value));
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.textContent ?? '');
      document.querySelectorAll('[value]').forEach((el) => texts.push(el.getAttribute('value') ?? ''));
      return texts;
    });
    expect(secretsFoundIn(shownOnPage, secretHashes), 'no secret value is on the page').toEqual([]);

    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const view = await AdminApi.asAdmin(request).get(`/hosts/${targetHost.uuid}/environment`);
    expect(view.status).toBe(200);
    for (const body of [view.body, pageView]) {
      expect(Object.keys(body).sort()).toEqual([...VIEW_KEYS].sort());
      expect(body.canSave).toBe(true);
      expect(body.error).toBeNull();
      const settings = settingsOf(body);
      expect(settings.length).toBe(after.masterActive);
      for (const setting of settings) {
        expect(setting.settingUuid, setting.configurationKey).toMatch(GUID);
        expect(Object.keys(setting), setting.configurationKey).not.toContain('environmentSettingId');
        if (setting.isSensitive) {
          expect(setting.value, `${setting.configurationKey} value`).toBeNull();
          expect(setting.hostValue, `${setting.configurationKey} hostValue`).toBeNull();
        }
      }
      expect(secretsFoundIn(body, secretHashes), 'no secret value is in the Admin API response').toEqual([]);
    }
  });

  test('REC-02 a changed value is saved to HOST_MASTER and the host database, the same value in both', async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    expect(masterValue(targetId, SAFE_SETTING)).toBe(original);
    expect(hostValue(SAFE_SETTING)).toBe(original);
    const probe = probeFor(original, '23', '24');

    try {
      await environment.setValue(SAFE_SETTING, probe);
      await environment.save.click();
      await shell.expectStatus('Saved 1 setting.', 'warning');
      await environment.countdown.decline();

      expect(masterValue(targetId, SAFE_SETTING)).toBe(probe);
      expect(hostValue(SAFE_SETTING)).toBe(probe);
      expect(masterStamp(targetId, SAFE_SETTING)).toContain(`|${adminAccount()!.email}`);

      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);
      await expect(environment.differsBadges()).toHaveCount(0);
      await expect(environment.lastPushed).toContainText('Last sent to the host');
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.setValue(SAFE_SETTING, original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
        await environment.countdown.decline();
      }
    }
    expect(masterValue(targetId, SAFE_SETTING)).toBe(original);
    expect(hostValue(SAFE_SETTING)).toBe(original);
  });

  test('REC-03 a value the host refuses is shown on its field, and neither HOST_MASTER nor the host changes', async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const masterBefore = masterStamp(targetId, SAFE_SETTING);
    const hostBefore = hostStamp(SAFE_SETTING);
    const since = markChangeLogs();

    await environment.setValue(SAFE_SETTING, '99999999999');
    await expect(environment.save).toBeEnabled();
    await environment.save.click();
    await shell.expectStatus('The host API refused the change, so nothing was saved', 'error');
    await expect(environment.error(SAFE_SETTING)).toContainText('whole number');
    await expect(environment.countdown.root).toHaveCount(0);

    expect(masterValue(targetId, SAFE_SETTING)).toBe(original);
    expect(masterStamp(targetId, SAFE_SETTING)).toBe(masterBefore);
    expect(hostValue(SAFE_SETTING)).toBe(original);
    expect(hostStamp(SAFE_SETTING)).toBe(hostBefore);
    expect(changeLogsFor(targetId, since), 'the change-log entry was rolled back too').toBe(0);

    await environment.open(targetHost.uuid);
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
  });

  test('REC-04 a value changed in the host database is flagged, and Send to host puts HOST_MASTER\'s value back on the host', async ({ page, request, targetHost, shell }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const drift = (await AdminApi.asAdmin(request).get(`/hosts/${targetHost.uuid}/environment`)).body.driftCount;
    test.skip(drift !== 0, `The host already differs from HOST_MASTER on ${drift} settings; Send to host would overwrite them.`);
    const original = masterValue(targetId, PUSH_SETTING);
    expect(hostValue(PUSH_SETTING)).toBe(original);
    const probe = probeFor(original, '121', '122');
    const environment = new HostEnvironmentPage(page);

    try {
      setHostValue(PUSH_SETTING, probe);
      await environment.open(targetHost.uuid);
      await environment.reveal(PUSH_SETTING);

      await expect(environment.field(PUSH_SETTING)).toHaveAttribute('data-differs', 'true');
      await expect(environment.differsBadge(PUSH_SETTING)).toHaveText('Changed on the host');
      await expect(environment.differsBadges()).toHaveCount(1);
      await expect(environment.hint(PUSH_SETTING)).toContainText(`host has "${probe}"`);
      await expect(environment.input(PUSH_SETTING)).toHaveValue(original!);
      expect(masterValue(targetId, PUSH_SETTING), 'opening the page never overwrites a HOST_MASTER value').toBe(original);
      await expect(environment.driftItems).toHaveCount(1);
      await expect(environment.driftItem(PUSH_SETTING)).toContainText(original!);
      await expect(environment.driftItem(PUSH_SETTING)).toContainText(probe);
      await expect(environment.save).toBeEnabled();
      await expect(environment.save).toHaveText(/Send to host/);

      await environment.save.click();
      await shell.expectStatus("Sent HOST_MASTER's value for 1 setting changed on the host.", 'warning');
      await environment.countdown.decline();

      expect(hostValue(PUSH_SETTING)).toBe(original);
      expect(masterValue(targetId, PUSH_SETTING)).toBe(original);

      await environment.open(targetHost.uuid);
      await expect(environment.driftCard).toHaveCount(0);
      await expect(environment.differsBadges()).toHaveCount(0);
      await expect(environment.save).toBeDisabled();
    } finally {
      if (hostValue(PUSH_SETTING) !== original) setHostValue(PUSH_SETTING, original!);
    }
    expect(hostValue(PUSH_SETTING)).toBe(original);
  });

  test("REC-05 Take the host's values copies a host-side change into HOST_MASTER after confirming, and leaves the host as it is", async ({ page, request, targetHost, shell }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const drift = (await AdminApi.asAdmin(request).get(`/hosts/${targetHost.uuid}/environment`)).body.driftCount;
    test.skip(drift !== 0, `The host already differs from HOST_MASTER on ${drift} settings; taking the host's values would copy them all.`);
    const original = masterValue(targetId, TAKE_SETTING);
    expect(hostValue(TAKE_SETTING)).toBe(original);
    const probe = probeFor(original, '31', '32');
    const environment = new HostEnvironmentPage(page);
    const puts: string[] = [];
    page.on('request', (sent) => {
      if (sent.method() === 'PUT') puts.push(sent.url());
    });

    try {
      setHostValue(TAKE_SETTING, probe);
      const hostBefore = hostStamp(TAKE_SETTING);
      await environment.open(targetHost.uuid);
      await expect(environment.driftItem(TAKE_SETTING)).toBeVisible();

      await environment.takeHostValues.click();
      await environment.confirmDialog.dismiss();
      expect(masterValue(targetId, TAKE_SETTING), 'cancelling takes nothing').toBe(original);

      await environment.takeHostValues.click();
      await environment.confirmDialog.accept();
      await shell.expectStatus("Took the host's value for 1 setting into HOST_MASTER.");

      expect(masterValue(targetId, TAKE_SETTING)).toBe(probe);
      expect(masterStamp(targetId, TAKE_SETTING)).toContain(`|${adminAccount()!.email}`);
      expect(hostValue(TAKE_SETTING)).toBe(probe);
      expect(hostStamp(TAKE_SETTING), 'the host row was not written').toBe(hostBefore);
      expect(puts, 'nothing was sent to the host').toEqual([]);

      await environment.open(targetHost.uuid);
      await expect(environment.driftCard).toHaveCount(0);
      await environment.reveal(TAKE_SETTING);
      await expect(environment.input(TAKE_SETTING)).toHaveValue(probe);
    } finally {
      restoreSettingRows(targetId, rows.filter((row) => row.key === TAKE_SETTING));
    }
    expect(masterValue(targetId, TAKE_SETTING)).toBe(original);
    expect(hostValue(TAKE_SETTING)).toBe(original);
  });

  test('REC-06 a feature save the host cannot receive leaves HOST_MASTER unchanged and says nothing was saved', async ({ page, request }) => {
    const uuid = hostUuidByKey(UNREACHABLE_HOST_KEY);
    const id = hostIdByKey(UNREACHABLE_HOST_KEY);
    const before = masterFeatureFlags(id);
    const stamps = () => queryMasterDb(`SELECT CONVERT(varchar(30), MAX(Updated), 126) FROM app.HostFeatures WHERE HostID_FK = ${id}`);
    const stampBefore = stamps();
    const since = markChangeLogs();

    const features = new HostFeaturesPage(page);
    await features.open(uuid);
    await expect(features.hostError).toContainText('could not be reached');
    await features.setOn('maps', true);
    await features.save.click();
    await expect(features.errors).toContainText('The host API did not take the features, so nothing was saved');

    expect(masterFeatureFlags(id)).toEqual(before);
    expect(stamps()).toBe(stampBefore);
    expect(changeLogsFor(id, since)).toBe(0);
    expect(featuresSync(id)?.status).toBe('Failed');

    await features.open(uuid);
    await expect(features.checkbox('maps')).toBeChecked({ checked: false });

    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const refused = await AdminApi.asAdmin(request).put(`/hosts/${uuid}/features/product`, { enabled: ['maps'] });
    expect(refused.status).toBe(502);
    expect(refused.body.detail).toContain('nothing was saved');
    expect(masterFeatureFlags(id)).toEqual(before);
    expect(stamps()).toBe(stampBefore);
  });

  test('REC-07 an environment save for a host whose API cannot be reached returns 502 and changes nothing; the page shows the HOST_MASTER values with Save off', async ({ page, request }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const uuid = hostUuidByKey(UNREACHABLE_HOST_KEY);
    const id = hostIdByKey(UNREACHABLE_HOST_KEY);
    const settingUuid = masterUuid(id, SAFE_SETTING);
    const before = masterStamp(id, SAFE_SETTING);
    const since = markChangeLogs();

    const saved = await AdminApi.asAdmin(request).put(`/hosts/${uuid}/environment`, { values: { [settingUuid]: '61' }, secrets: {} });
    expect(saved.status).toBe(502);
    expect(saved.body.detail).toContain('could not be reached');
    expect(masterValue(id, SAFE_SETTING)).toBe('60');
    expect(masterStamp(id, SAFE_SETTING)).toBe(before);
    expect(changeLogsFor(id, since)).toBe(0);

    const environment = new HostEnvironmentPage(page);
    await environment.openUnreachable(uuid);
    await expect(environment.loadWarning).toContainText('could not be reached');
    await expect(environment.save).toBeDisabled();
    await environment.reveal(SAFE_SETTING);
    await expect(environment.input(SAFE_SETTING)).toHaveValue('60');
    await expect(environment.field(SAFE_SETTING)).toHaveAttribute('data-setting-id', settingUuid);
  });

  test("REC-08 the host app's former root super admin (a user still holding a SuperAdmin row) is refused by the host API's environment settings (QC-801)", async ({ browser, request }) => {
    test.skip(!env.appUrl || !env.appApiUrl || !canUseIdentityDb() || !env.admin, "Needs APP_URL, APP_API_URL, Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway super admin.");
    const appUp = await request.get(env.appUrl!).then((response) => response.ok()).catch(() => false);
    test.skip(!appUp, `The host app is not running on ${env.appUrl}.`);

    removeHostSuperAdmins();
    seedSuperAdminRole();
    try {
      const user = seedHostSuperAdmin();
      const token = await hostAppAccessToken(browser, user);
      expect(token, 'the host app keeps an access token after sign-in').toBeTruthy();

      const { status, body } = await hostEnvironmentSettings(request, token!);
      expect([401, 403], `GET api/environment-setting as a SuperAdmin row holder: ${status}`).toContain(status);
      expect(secretsFoundIn(body, hostSecretHashes()), 'no secret value is in the host API response').toEqual([]);
    } finally {
      try {
        removeHostSuperAdmins();
      } finally {
        removeSuperAdminRole();
      }
    }
  });

  test('REC-09 a host with no API address says so on Environment, and a save is kept in HOST_MASTER only', async ({ page, shell }) => {
    const uuid = hostUuidByKey(NO_API_HOST_KEY);
    const id = hostIdByKey(NO_API_HOST_KEY);
    const environment = new HostEnvironmentPage(page);
    await environment.open(uuid);
    await expect(environment.notice).toContainText('no API address');
    await expect(environment.loadWarning).toHaveCount(0);
    await expect(environment.driftCard).toHaveCount(0);
    await expect(environment.secretInputs()).toHaveCount(1);
    await expect(environment.secretInputs()).toHaveValue('');

    await environment.setValue(NO_API_SETTING, '8');
    await environment.save.click();
    await shell.expectStatus('Saved 1 setting. The host has no API address, so they are kept in HOST_MASTER only.');
    expect(masterValue(id, NO_API_SETTING)).toBe('8');
    expect(masterStamp(id, NO_API_SETTING)).toContain(`|${adminAccount()!.email}`);
    expect(queryMasterDb(`SELECT COUNT(*) FROM app.HostSyncs WHERE HostID_FK = ${id} AND Area = N'Environment'`), 'nothing was sent, so no sync is recorded').toBe('0');

    await environment.open(uuid);
    await environment.reveal(NO_API_SETTING);
    await expect(environment.input(NO_API_SETTING)).toHaveValue('8');
  });
});
