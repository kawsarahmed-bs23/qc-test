import { test, expect } from '../fixtures/test';
import { canSeedLocalDb, canUseIdentityDb, canUseMasterDb, queryIdentityDb, queryMasterDb, querySingleValue, runIdentitySeedScript, runMasterSeedScript, runSeedScript } from '../fixtures/localDb';
import {
  featureCatalog,
  featuresSync,
  hostDbFeatureFlags,
  masterFeatureFlags,
  masterHostId,
  restoreHostFeatures,
  snapshotHostFeatures,
  type FeatureSnapshot,
} from '../fixtures/featureSnapshot';
import { adminAccount } from '../fixtures/throwawayUsers';
import { AdminApi, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { authorizeUrl, identityLanding } from '../pages/HostSignInFlow';
import { HostEnvironmentPage, HostFeaturesPage, HostFormPage, HostListPage, UserDetailPage } from '../pages/HostManagementPages';
import { DashboardPage, HostNav } from '../pages/HostPages';
import { UserListPage } from '../pages/UserListPage';
import { env } from '../config/environment';

const MEMBER = 'e2e.qc739.member@quarryconnect.test';
const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';
const UNREACHABLE_API = 'https://localhost:9';
const PROBE = { key: 'e2e_qc775_probe', label: 'E2E QC-775 probe' };

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

test.describe('Hosts (QC-739, Angular since QC-742)', () => {
  test('HM-01 the hosts list links each host by its UUID and shows its sign-in client, with no Identity link column', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const list = new HostListPage(page);
    await list.open();
    const row = list.row(targetHost.uuid);
    await expect(row).toContainText(targetHost.name);
    if (env.hostClient) {
      await expect(row.locator('td.mat-column-clientId')).toHaveText(env.hostClient.clientId);
    }
    await expect(row.locator('[data-testid="host-identity"]')).toHaveCount(0);
    await expect(list.link(targetHost.uuid)).toHaveAttribute('href', `#/hosts/${targetHost.uuid}`);
  });

  test("HM-02 a host's page shows its UUID and sign-in client and links to its Sign-in tab, never a numeric id", async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    await expect(form.facts).toContainText(targetHost.uuid);
    await expect(form.clientId).not.toHaveText('-');
    await expect(new HostNav(page).tab('sign-in')).toHaveAttribute('href', `#/hosts/${targetHost.uuid}/sign-in`);
    expect(page.url()).not.toMatch(/\/hosts\/\d+(\/|$)/);
  });

  test('HM-03 Add host refuses addresses without a scheme, then an existing name, and keeps nothing', async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openNew();
    await form.fill({
      name: targetHost.name,
      hostKey: 'e2e-qc739-refused',
      clientId: 'e2e-qc739.refused',
      databaseName: 'QuarryConnect_Dev',
      organisationId: '30',
      uiUrl: 'localhost:4200',
      apiBaseUrl: 'ftp://example.test',
    });
    await form.create.click();

    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    await expect(form.error('uiUrl')).toContainText('http:// or https://');
    await expect(form.error('apiBaseUrl')).toContainText('http:// or https://');

    await form.field('UiUrl').fill('http://localhost:4299');
    await form.field('ApiBaseUrl').fill('');
    await form.create.click();
    await expect(form.error('name')).toHaveText('Another host already has this name.');
    await expect(form.error('uiUrl')).toHaveCount(0);
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
  });

  test.describe('a created host', () => {
    test.afterAll(() => {
      if (canUseMasterDb()) runMasterSeedScript('master-e2e-hosts.remove.sql');
    });

    test('HM-05 a created host can be signed into once Identity reads the HOST_MASTER feed, and deactivating it after confirming stops sign-in', { tag: '@create' }, async ({ page, shell }) => {
      test.setTimeout(2 * env.identityHostCacheSeconds * 1000 + 90_000);
      const stamp = Date.now().toString(36);
      const clientId = `e2e-qc739.web${stamp}`;
      const uiUrl = 'http://localhost:4297';
      const form = new HostFormPage(page);

      await form.openNew();
      await form.fill({
        name: `E2E QC-739 ${stamp}`,
        hostKey: `e2e-qc739-${stamp}`,
        clientId,
        databaseName: 'QuarryConnect_Dev',
        organisationId: '99',
        uiUrl,
      });
      await form.create.click();

      await expect(page).toHaveURL(/#\/hosts\/[0-9a-f-]{36}$/);
      await shell.expectStatus('created');
      await expect(form.clientId).toHaveText(clientId);

      const flow = authorizeUrl({ client_id: clientId, redirect_uri: `${uiUrl}/` });
      const wait = { timeout: env.identityHostCacheSeconds * 1000, intervals: [2_000, 5_000, 10_000] };
      await expect.poll(() => identityLanding(flow), { message: 'Identity reads the new host', ...wait }).toMatch(/\/Account\/Login/i);

      await form.deactivate.click();
      await form.confirmDialog.accept();
      await expect(page).toHaveURL(adminUrl('/hosts'));
      await shell.expectStatus('deactivated');
      await expect.poll(() => identityLanding(flow), { message: 'Identity drops the deactivated host', ...wait }).toBe(env.landingUrl ?? 'https://www.quarryconnect.com/');
    });
  });
});

test.describe('Host features (QC-739, Angular since QC-742)', () => {
  test('HF-01 product features come from the HOST_MASTER catalog with their rules, and MFA from HOST_MASTER', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    for (const key of ['quickbooks', 'sage', 'dispatch', 'dispatch_statewide', 'maps']) {
      await expect(features.feature(key)).toBeAttached();
    }
    await expect(features.feature('sage')).toHaveAttribute('data-exclusive', 'quickbooks');
    await expect(features.feature('dispatch_statewide')).toHaveAttribute('data-requires', 'dispatch');
    await expect(features.mfa).toBeAttached();
  });

  test('HF-02 the page locks a feature whose dependency is off or whose rival is on', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);

    await features.setOn('dispatch', true);
    await features.setOn('dispatch_statewide', true);
    await features.setOn('dispatch', false);
    await expect(features.checkbox('dispatch_statewide')).not.toBeChecked();
    await expect(features.checkbox('dispatch_statewide')).toBeDisabled();

    await features.setOn('sage', false);
    await features.setOn('quickbooks', true);
    await expect(features.checkbox('sage')).toBeDisabled();
    await features.setOn('quickbooks', false);
    await expect(features.checkbox('sage')).toBeEnabled();
  });

  test('HF-03 a direct API call that breaks a rule is refused and changes nothing', async ({ page, request, targetHost }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const before = await features.enabledKeys();
    const api = AdminApi.asAdmin(request);

    const exclusive = await api.put(`/hosts/${targetHost.uuid}/features/product`, { enabled: [...new Set([...before, 'quickbooks', 'sage'])] });
    expect(exclusive.status).toBe(400);
    expect(exclusive.text).toContain('QuickBooks and Sage cannot both be on.');

    const dependency = await api.put(`/hosts/${targetHost.uuid}/features/product`, { enabled: [...before.filter((k) => k !== 'dispatch'), 'dispatch_statewide'] });
    expect(dependency.status).toBe(400);
    expect(dependency.text).toContain('Statewide dispatch needs Dispatch to be on.');

    const unknown = await api.put(`/hosts/${targetHost.uuid}/features/product`, { enabled: [...before, 'e2e_qc775_not_in_catalog'] });
    expect(unknown.status).toBe(400);
    expect(unknown.text).toContain('Unknown feature: e2e_qc775_not_in_catalog.');

    await features.open(targetHost.uuid);
    expect((await features.enabledKeys()).sort()).toEqual([...before].sort());
  });

  test('HF-04 switching Maps saves through the host API, survives a reload and names who changed it', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('maps');

    try {
      await features.setOn('maps', !original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change.');
      await features.open(targetHost.uuid);
      await expect(features.checkbox('maps')).toBeChecked({ checked: !original });
      await expect(features.row('maps')).toContainText(`Changed by ${adminAccount()!.email}`);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }
  });

  test("HF-05 the MFA switch shows the host's HOST_MASTER mfa row and says Identity applies it within 5 minutes (QC-775)", async ({ page, targetHost }) => {
    test.skip(!canUseMasterDb(), 'Needs MASTER_SQL_DATABASE (local only).');
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const stored = queryMasterDb(
      `SELECT CAST(f.IsEnabled AS int) FROM app.HostFeatures f JOIN app.Hosts h ON h.HostID = f.HostID_FK WHERE h.HostUUID = '${targetHost.uuid}' AND f.Active = 1 AND f.FeatureKey = 'mfa'`,
    );
    await expect(features.mfa).toHaveAttribute('aria-checked', stored === '1' ? 'true' : 'false');
    await expect(page.locator('#mfa-error')).toHaveCount(0);
    await expect(page.locator('#mfa-saved-copy')).toHaveCount(0);
    await expect(page.getByText('Identity reads it and applies it')).toBeVisible();
  });
});

test.describe('Host features owned by HOST_MASTER (QC-775)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canUseMasterDb() || !canSeedLocalDb(), 'Needs HOST_MASTER and the host database (local only).');

  let snapshot: FeatureSnapshot;
  let rockRidge: { uuid: string; hostId: number; organisationId: number };

  const throwawayUuid = (hostKey: string) => queryMasterDb(`SELECT CAST(HostUUID AS varchar(36)) FROM app.Hosts WHERE HostKey = N'${hostKey}'`)!.toLowerCase();

  test.beforeAll(() => {
    const uuid = queryMasterDb(`SELECT CAST(HostUUID AS varchar(36)) FROM app.Hosts WHERE Name = ${sqlText(env.hostName)} AND Active = 1`)!.toLowerCase();
    snapshot = snapshotHostFeatures(uuid);
    rockRidge = { uuid, hostId: snapshot.hostId, organisationId: snapshot.organisationId };
    runMasterSeedScript('master-qc775-features.remove.sql');
    runSeedScript('host-qc775-features.remove.sql');
    runMasterSeedScript('master-qc775-features.apply.sql');
  });

  test.afterAll(() => {
    runMasterSeedScript('master-qc775-features.remove.sql');
    runSeedScript('host-qc775-features.remove.sql');
    if (snapshot) restoreHostFeatures(snapshot, [adminAccount()!.email, 'admin.sync']);
  });

  test('HF-06 every catalog feature is listed for the target host with its label and the on/off saved in HOST_MASTER', async ({ page, targetHost }) => {
    const catalog = featureCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    const saved = masterFeatureFlags(rockRidge.hostId);
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);

    expect(await features.featureKeys()).toEqual(catalog.map((f) => f.key));
    for (const { key, label } of catalog) {
      await expect(features.feature(key), key).toContainText(label);
      await expect(features.checkbox(key), key).toBeChecked({ checked: saved[key] ?? false });
    }
    await expect(features.mfa).toHaveAttribute('aria-checked', saved.mfa ? 'true' : 'false');
    await expect(features.hostError).toHaveCount(0);
    await expect(features.empty).toHaveCount(0);
  });

  test('HF-07 a host with no API address lists the whole catalog for editing, warns, and a save is kept in HOST_MASTER', async ({ page, request, shell }) => {
    const uuid = throwawayUuid('e2e-qc775-features');
    const id = masterHostId(uuid);
    const catalog = featureCatalog();
    const features = new HostFeaturesPage(page);
    await features.open(uuid);

    expect(await features.featureKeys()).toEqual(catalog.map((f) => f.key));
    await expect(features.hostError).toContainText('no API address');
    await expect(features.pending).toHaveCount(0);
    await expect(features.lastPushed).toHaveText('Not sent to the host yet.');
    expect(await features.enabledKeys()).toEqual([]);
    for (const key of ['quickbooks', 'sage', 'dispatch', 'reports', 'maps']) {
      await expect(features.checkbox(key), key).toBeEnabled();
    }

    await features.setOn('maps', true);
    await features.setOn('reports', true);
    await features.save.click();
    await shell.expectStatus('Saved 2 feature changes.');
    await shell.expectStatus('kept in HOST_MASTER');

    const stored = masterFeatureFlags(id);
    expect(Object.keys(stored).sort()).toEqual(catalog.map((f) => f.key).sort());
    expect(Object.entries(stored).filter(([, on]) => on).map(([key]) => key).sort()).toEqual(['maps', 'reports']);
    expect(featuresSync(id), 'nothing was sent, so no sync is recorded').toBeNull();

    await features.open(uuid);
    expect((await features.enabledKeys()).sort()).toEqual(['maps', 'reports']);
    await expect(features.row('maps')).toContainText(`Changed by ${adminAccount()!.email}`);

    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const api = AdminApi.asAdmin(request);
    const view = await api.get(`/hosts/${uuid}/features`);
    expect(view.status).toBe(200);
    expect(view.body.hostError).toContain('no API address');
    expect(view.body.pendingKeys).toEqual([]);
    expect(view.body.productFeatures.map((f: { key: string }) => f.key)).toEqual(catalog.map((f) => f.key));
    const saved = await api.put(`/hosts/${uuid}/features/product`, { enabled: ['maps'] });
    expect(saved.status).toBe(200);
    expect(saved.body.message).toContain('kept in HOST_MASTER');
    expect(masterFeatureFlags(id).reports).toBe(false);
  });

  test('HF-08 a save on the target host reaches the host database for every catalog feature and leaves nothing pending', async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('ai_ocr');

    try {
      await features.setOn('ai_ocr', !original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change. The host has them now.');

      expect(hostDbFeatureFlags(rockRidge.organisationId).ai_ocr).toBe(!original);
      expect(masterFeatureFlags(rockRidge.hostId).ai_ocr).toBe(!original);
      const hostDb = hostDbFeatureFlags(rockRidge.organisationId);
      const master = masterFeatureFlags(rockRidge.hostId);
      for (const { key } of featureCatalog()) {
        expect(hostDb[key], `host database ${key}`).toBe(master[key] ?? false);
      }
      expect(featuresSync(rockRidge.hostId)?.status).toBe('Succeeded');

      await features.open(targetHost.uuid);
      await expect(features.checkbox('ai_ocr')).toBeChecked({ checked: !original });
      await expect(features.pending).toHaveCount(0);
      await expect(features.pendingBadges).toHaveCount(0);
      await expect(features.hostError).toHaveCount(0);
      await expect(features.lastPushed).toContainText('Last sent to the host');
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('ai_ocr')) !== original) {
        await features.setOn('ai_ocr', original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }
    expect(hostDbFeatureFlags(rockRidge.organisationId).ai_ocr ?? false).toBe(original);
  });

  test('HF-09 a new catalog feature is listed for every host, can be switched on, reaches the host database and shows on the dashboard card', async ({ page, request, targetHost, shell }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const features = new HostFeaturesPage(page);
    const api = AdminApi.asAdmin(request);

    try {
      queryMasterDb(`INSERT app.Features (FeatureKey, Label, SortOrder, CreatedBy, UpdatedBy) VALUES ('${PROBE.key}', N'${PROBE.label}', 9990, N'e2e', N'e2e')`);

      const hosts = (queryMasterDb(`SELECT CAST(HostUUID AS varchar(36)) FROM app.Hosts WHERE Active = 1`) ?? '').split(/\r?\n/).filter(Boolean);
      expect(hosts.length).toBeGreaterThan(1);
      for (const uuid of hosts) {
        const view = await api.get(`/hosts/${uuid.toLowerCase()}/features`);
        expect(view.status, uuid).toBe(200);
        const probe = view.body.productFeatures.find((f: { key: string }) => f.key === PROBE.key);
        expect(probe, `${uuid} lists the probe`).toMatchObject({ label: PROBE.label, enabled: false });
      }

      await features.open(targetHost.uuid);
      await expect(features.feature(PROBE.key)).toContainText(PROBE.label);
      await expect(features.pendingBadge(PROBE.key)).toHaveCount(0);
      await features.setOn(PROBE.key, true);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change. The host has them now.');

      expect(hostDbFeatureFlags(rockRidge.organisationId)[PROBE.key]).toBe(true);
      expect(masterFeatureFlags(rockRidge.hostId)[PROBE.key]).toBe(true);
      await features.open(targetHost.uuid);
      await expect(features.checkbox(PROBE.key)).toBeChecked();
      await expect(features.pendingBadges).toHaveCount(0);

      const dashboard = new DashboardPage(page);
      await dashboard.open();
      await expect(dashboard.hostFeatures(targetHost.uuid)).toContainText(PROBE.label);
    } finally {
      runMasterSeedScript('master-qc775-features.remove.sql');
      runSeedScript('host-qc775-features.remove.sql');
      runMasterSeedScript('master-qc775-features.apply.sql');
    }

    expect(queryMasterDb(`SELECT COUNT(*) FROM app.Features WHERE FeatureKey = '${PROBE.key}'`)).toBe('0');
    expect(queryMasterDb(`SELECT COUNT(*) FROM app.HostFeatures WHERE FeatureKey = '${PROBE.key}'`)).toBe('0');
    expect(querySingleValue(`SELECT COUNT(*) FROM app.HostFeatures WHERE FeatureKey = '${PROBE.key}'`)).toBe('0');
    await features.open(targetHost.uuid);
    await expect(features.feature(PROBE.key)).toHaveCount(0);
    await expect(features.pendingBadges).toHaveCount(0);
  });

  test('HF-10 a value changed in the host database behind Admin is flagged as not on the host yet, and saving sends it back', async ({ page, targetHost, shell }) => {
    const before = hostDbFeatureFlags(rockRidge.organisationId);
    test.skip(before.maps === undefined, 'The host database has no maps row to change.');
    const master = masterFeatureFlags(rockRidge.hostId).maps ?? false;
    const features = new HostFeaturesPage(page);

    try {
      querySingleValue(`UPDATE app.HostFeatures SET Enabled = ${master ? 0 : 1} WHERE OrganisationID_FK = ${rockRidge.organisationId} AND FeatureKey = 'maps'`);

      await features.open(targetHost.uuid);
      await expect(features.pending).toBeVisible();
      await expect(features.pendingBadge('maps')).toHaveText('Not on the host yet');
      await expect(features.pendingBadges).toHaveCount(1);
      await expect(features.checkbox('maps')).toBeChecked({ checked: master });

      await features.save.click();
      await shell.expectStatus('No changes. The host has them now.');
      expect(hostDbFeatureFlags(rockRidge.organisationId).maps).toBe(master);

      await features.open(targetHost.uuid);
      await expect(features.pending).toHaveCount(0);
      await expect(features.pendingBadges).toHaveCount(0);
    } finally {
      querySingleValue(`UPDATE app.HostFeatures SET Enabled = ${before.maps ? 1 : 0} WHERE OrganisationID_FK = ${rockRidge.organisationId} AND FeatureKey = 'maps'`);
    }
  });

  test('HF-11 when the host API cannot be reached, a save is kept in HOST_MASTER, marked failed, and goes through on the next save', async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('ai_ocr');
    const hostBefore = hostDbFeatureFlags(rockRidge.organisationId).ai_ocr ?? false;
    const originalUrl = queryMasterDb(`SELECT ApiBaseUrl FROM app.Hosts WHERE HostID = ${rockRidge.hostId}`);

    try {
      queryMasterDb(`UPDATE app.Hosts SET ApiBaseUrl = N'${UNREACHABLE_API}' WHERE HostID = ${rockRidge.hostId}`);
      await features.open(targetHost.uuid);
      await expect(features.hostError).toContainText('could not be reached');

      await features.setOn('ai_ocr', !original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change. They are kept in HOST_MASTER');
      await shell.expectStatus('Save again to send them.');
      expect(masterFeatureFlags(rockRidge.hostId).ai_ocr).toBe(!original);
      expect(hostDbFeatureFlags(rockRidge.organisationId).ai_ocr ?? false).toBe(hostBefore);
      expect(featuresSync(rockRidge.hostId)?.status).toBe('Failed');
    } finally {
      queryMasterDb(`UPDATE app.Hosts SET ApiBaseUrl = ${originalUrl === null ? 'NULL' : sqlText(originalUrl)} WHERE HostID = ${rockRidge.hostId}`);
    }

    await features.open(targetHost.uuid);
    await expect(features.hostError).toHaveCount(0);
    await expect(features.pendingBadge('ai_ocr')).toBeVisible();
    await features.setOn('ai_ocr', original);
    await features.save.click();
    await shell.expectStatus('Saved 1 feature change. The host has them now.');
    expect(featuresSync(rockRidge.hostId)?.status).toBe('Succeeded');
    await features.open(targetHost.uuid);
    await expect(features.pendingBadges).toHaveCount(0);
    expect(masterFeatureFlags(rockRidge.hostId).ai_ocr ?? false).toBe(original);
  });

  test("HF-12 the first open of a host with no HOST_MASTER feature rows takes the host API's current values into HOST_MASTER", async ({ page }) => {
    const uuid = throwawayUuid('e2e-qc775-adopt');
    const id = masterHostId(uuid);
    expect(masterFeatureFlags(id)).toEqual({});
    const live = hostDbFeatureFlags(rockRidge.organisationId);
    const catalog = featureCatalog();

    const features = new HostFeaturesPage(page);
    await features.open(uuid);
    await expect(features.hostError).toHaveCount(0);
    await expect(features.pendingBadges).toHaveCount(0);

    const adopted = masterFeatureFlags(id);
    expect(Object.keys(adopted).sort()).toEqual(catalog.map((f) => f.key).sort());
    for (const { key } of catalog) {
      expect(adopted[key], key).toBe(live[key] ?? false);
      await expect(features.checkbox(key), key).toBeChecked({ checked: live[key] ?? false });
    }
    expect(queryMasterDb(`SELECT COUNT(*) FROM app.HostFeatures WHERE HostID_FK = ${id} AND CreatedBy <> N'admin.sync'`)).toBe('0');
    expect(featuresSync(id)?.status).toBe('Succeeded');
  });
});

test.describe('Host environment (QC-739, Angular since QC-742)', () => {
  test('HE-01 secrets are never filled in: each shows only whether it is set', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const secrets = environment.secretInputs();
    expect(await secrets.count()).toBeGreaterThan(0);
    for (const secret of await secrets.all()) {
      await expect(secret).toHaveAttribute('type', 'password');
      await expect(secret).toHaveAttribute('autocomplete', 'new-password');
      await expect(secret).toHaveValue('');
    }
    await expect(environment.secretFields().first().locator('mat-hint')).toHaveText(/^\s*(Set|Not set)\s*$/);
  });

  test('HE-02 a value of the wrong type is refused on its own field and nothing is sent', async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const puts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'PUT') puts.push(request.url());
    });

    await environment.setValue(SAFE_SETTING, '2.5');
    await environment.save.click();
    await expect(environment.error(SAFE_SETTING)).toHaveText('Enter a whole number.');
    await shell.expectStatus('Fix the highlighted fields first.', 'error');
    expect(puts).toEqual([]);

    await environment.open(targetHost.uuid);
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
  });

  test('HE-03 a changed setting is saved alone and flags that the host API needs a restart', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const probe = original === '21' ? '22' : '21';

    try {
      await environment.setValue(SAFE_SETTING, probe);
      await environment.save.click();
      await shell.expectStatus('Saved 1 setting.', 'warning');
      await shell.expectStatus(SAFE_SETTING, 'warning');
      await environment.countdown.decline();
      await expect(environment.restartCardKeys).toHaveText([SAFE_SETTING]);

      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);
      await expect(environment.save).toBeDisabled();
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.setValue(SAFE_SETTING, original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
        await environment.countdown.decline();
      }
    }
  });

  test('HE-04 restart waits for a second click that warns everyone is disconnected', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restart.arm.click();
    await expect(environment.restart.arm).toHaveCount(0);
    await expect(environment.restart.confirm).toBeVisible();
    await expect(page.locator('.restart-warning')).toContainText('Every signed-in user is disconnected');
    await environment.restart.cancel.click();
    await expect(environment.restart.arm).toBeVisible();
  });
});

test.describe('Users (QC-739, Angular since QC-742; no host mappings since QC-775)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canUseIdentityDb(), "Needs Identity's local database to seed and remove the throwaway member user.");

  test.beforeAll(() => {
    runIdentitySeedScript('identity-qc739-member.apply.sql');
  });

  test.afterAll(() => {
    runIdentitySeedScript('identity-qc739.remove.sql');
  });

  test('HU-03 the user page shows the account with no hosts, says whether it is a platform admin, and switches it off and on after confirming', async ({ page, shell }) => {
    const list = new UserListPage(page);
    await list.open({ search: 'e2e.qc739.member' });
    await list.rowByEmail(MEMBER).locator('[data-testid="user-name"]').click();
    await expect(page).toHaveURL(/#\/users\/[0-9a-f-]{36}$/i);

    const detail = new UserDetailPage(page);
    await expect(detail.state).toHaveText('Account active');
    await expect(detail.platformAdmin).toHaveText('No');
    await expect(detail.twoFactor).toHaveText('Off');
    for (const id of ['#user-hosts', '#user-hosts-table', '#user-platform-roles']) {
      await expect(page.locator(id), id).toHaveCount(0);
    }

    await detail.deactivate.click();
    await detail.confirmDialog.dismiss();
    await expect(detail.state).toHaveText('Account active');

    await detail.setActive(false);
    await shell.expectStatus('deactivated and every session was ended');
    await expect(detail.state).toHaveText('Account deactivated');
    expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Email = ${sqlText(MEMBER)}`)).toBe('0');

    await detail.setActive(true);
    await shell.expectStatus('active again');
    await expect(detail.state).toHaveText('Account active');
    expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Email = ${sqlText(MEMBER)}`)).toBe('1');
  });

  test('HU-05 the Users page finds a user and links to them by their Identity id', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: 'e2e.qc739.member' });
    const link = list.rowByEmail(MEMBER).locator('[data-testid="user-name"]');
    await expect(link).toHaveText('E2E QC-739 Member');
    await expect(link).toHaveAttribute('href', /^#\/users\/[0-9a-f-]{36}$/i);
    await expect(list.cell(list.rowByEmail(MEMBER), 'user-platform-admin')).toHaveCount(0);
  });
});
