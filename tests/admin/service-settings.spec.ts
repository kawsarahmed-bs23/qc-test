import { randomBytes } from 'crypto';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { canUseMasterDb, queryMasterDb } from '@utils/localDb';
import { adminAccount } from '@utils/throwawayUsers';
import { AdminApi, canUseAdminApi } from '@api/admin.api';
import { adminUrl } from '@pages/admin-shell.page';
import { SERVICE_SETTING_COUNTS, SERVICE_SETTING_GROUPS, ServiceSettingsApi, ServiceSettingsPage, type ServiceSlug } from '@pages/service-settings.page';

const TABLES: Record<ServiceSlug, string> = { 'drivers-api': 'app.DriversApiSettings', identity: 'app.IdentitySettings' };
const AREAS: Record<ServiceSlug, string> = { 'drivers-api': 'DriversApiSettings', identity: 'IdentitySettings' };

const COALESCE = 'Push:CoalesceSeconds';
const CORS = 'Cors:AllowedOrigins';
const CLIENT_IDS = 'Identity:AllowedClientIds';
const EXPO_TOKEN = 'Push:ExpoAccessToken';
const PUSH_ENABLED = 'Push:Enabled';
const SENDER_NAME = 'EmailSettings:SenderName';

function storedValue(service: ServiceSlug, key: string): string | null {
  const value = queryMasterDb(`SELECT ISNULL(Value, N'<null>') FROM ${TABLES[service]} WHERE SettingKey = N'${key}' AND Active = 1`);
  return value === '<null>' ? null : value;
}

function lastChangeLogId(): number {
  return Number(queryMasterDb('SELECT ISNULL(MAX(ChangeLogID), 0) FROM app.ChangeLogs'));
}

function activity(service: ServiceSlug, since: number): { summary: string; createdBy: string }[] {
  const output = queryMasterDb(
    `SELECT Summary + N'|' + CreatedBy FROM app.ChangeLogs WHERE ChangeLogID > ${since} AND Area = N'${AREAS[service]}' ORDER BY ChangeLogID`,
  );
  return (output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [summary, createdBy] = line.trim().split('|');
      return { summary, createdBy };
    });
}

test.describe('Service settings for the Drivers API and Identity (QC-1000)', { tag: ['@regression'] }, () => {
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');

  test('SSET-01 the sidebar opens the Drivers API settings page with its groups in catalog order, and the Identity settings page shows its own groups, each on its own address', async ({
    page,
    shell,
  }) => {
    const settings = new ServiceSettingsPage(page);
    await page.goto(adminUrl('/'));
    await shell.nav('drivers-api-settings').click();
    await expect(page).toHaveURL(adminUrl('/settings/drivers-api'));
    await expect(shell.heading).toHaveText('Drivers API settings');
    await expect(settings.root).toHaveAttribute('data-service', 'drivers-api');
    await expect(settings.groups.first()).toBeVisible();
    expect(await settings.groupNames()).toEqual(SERVICE_SETTING_GROUPS['drivers-api']);
    await expect(settings.header('Identity')).toHaveAttribute('aria-expanded', 'true');
    await expect(settings.header('Messaging')).toContainText('10 settings');
    await expect(settings.header('Messaging')).toContainText('need a restart');
    await expect(settings.root.locator('[data-setting-key]')).toHaveCount(SERVICE_SETTING_COUNTS['drivers-api'].total);
    await expect(page.getByRole('tab')).toHaveCount(0);

    await shell.nav('identity-settings').click();
    await expect(page).toHaveURL(adminUrl('/settings/identity'));
    await expect(shell.heading).toHaveText('Identity settings');
    await expect(settings.root).toHaveAttribute('data-service', 'identity');
    await expect(settings.groups.first()).toBeVisible();
    expect(await settings.groupNames()).toEqual(SERVICE_SETTING_GROUPS.identity);
    await expect(settings.root.locator('[data-setting-key]')).toHaveCount(SERVICE_SETTING_COUNTS.identity.total);

    await page.reload();
    await expect(settings.root).toHaveAttribute('data-service', 'identity');
    await expect(shell.heading).toHaveText('Identity settings');
  });

  test('SSET-02 GET api/service-settings returns every key with its flags, sends no secret value, and an unknown service is 404', async ({ request }) => {
    const api = new ServiceSettingsApi(AdminApi.asAdmin(request));
    for (const service of ['drivers-api', 'identity'] as ServiceSlug[]) {
      const result = await api.get(service);
      expect(result.status).toBe(200);
      expect(result.body.service).toBe(service);
      expect(result.body.groups.map((group) => group.name)).toEqual(SERVICE_SETTING_GROUPS[service]);
      const settings = result.body.groups.flatMap((group) => group.settings);
      expect(settings).toHaveLength(SERVICE_SETTING_COUNTS[service].total);
      const secrets = settings.filter((setting) => setting.isSensitive);
      expect(secrets).toHaveLength(SERVICE_SETTING_COUNTS[service].secrets);
      for (const secret of secrets) {
        expect(secret.value, `${secret.key} value is never sent`).toBeNull();
      }
      for (const setting of settings) {
        expect(Object.keys(setting).sort()).toEqual(
          ['settingUuid', 'key', 'value', 'type', 'description', 'isSensitive', 'hasValue', 'isRestartRequired', 'isRequired', 'updatedBy', 'updated'].sort(),
        );
        expect(setting.settingUuid).toMatch(/^[0-9a-f-]{36}$/i);
      }
    }
    const drivers = await api.all('drivers-api');
    expect(drivers.get(CORS)).toMatchObject({ type: 'list', isRestartRequired: false, isSensitive: false });
    expect(drivers.get(CLIENT_IDS)).toMatchObject({ type: 'list', isRestartRequired: true, isRequired: true });
    expect(drivers.get(COALESCE)).toMatchObject({ type: 'int', isRestartRequired: false });
    expect(drivers.get('Identity:Audience')).toMatchObject({ isRequired: true });
    expect(drivers.get('Messaging:DriversUuid')).toMatchObject({ type: 'guid' });
    expect(drivers.get('Twilio:AuthToken')).toMatchObject({ isSensitive: true, isRestartRequired: true });
    const identity = await api.all('identity');
    expect(identity.get('Invites:MaxLifetime')).toMatchObject({ type: 'timespan' });
    expect(identity.get('EmailSettings:Password')).toMatchObject({ isSensitive: true, isRestartRequired: false });
    expect(identity.has('IdentityServer:IssuerUri'), 'the issuer stays in Identity appsettings').toBe(false);

    expect((await api.get('host-api')).status).toBe(404);
  });

  test(
    'SSET-03 a live setting saved on the page keeps its value after a reload, shows the plain success message and writes one activity row with the admin as actor',
    { tag: '@write' },
    async ({ page, shell, request }) => {
      test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to read the stored value and the activity rows.');
      const api = new ServiceSettingsApi(AdminApi.asAdmin(request));
      const original = (await api.setting('drivers-api', COALESCE)).value;
      const probe = original === '7' ? '8' : '7';
      const since = lastChangeLogId();
      const settings = new ServiceSettingsPage(page);

      try {
        await settings.open('drivers-api');
        await settings.expand('Push');
        await expect(settings.restartBadge(COALESCE)).toHaveCount(0);
        await settings.input(COALESCE).fill(probe);
        await settings.save('Push');
        await shell.expectStatus('Settings saved.');
        await expect(page.locator('.warning-snackbar')).toHaveCount(0);

        await settings.open('drivers-api');
        await settings.expand('Push');
        await expect(settings.input(COALESCE)).toHaveValue(probe);
        await expect(settings.updatedHint(COALESCE)).toContainText(`Changed by ${adminAccount()!.email}`);
        expect(storedValue('drivers-api', COALESCE)).toBe(probe);
        expect(activity('drivers-api', since)).toEqual([
          { summary: `Changed ${COALESCE} from ${original ?? '(default)'} to ${probe}`, createdBy: adminAccount()!.email },
        ]);
      } finally {
        if ((await api.setting('drivers-api', COALESCE)).value !== original) await api.restore('drivers-api', { [COALESCE]: original });
      }
      expect(storedValue('drivers-api', COALESCE)).toBe(original);
    },
  );

  test(
    'SSET-04 a list setting is edited as chips, saved as a JSON array, and a restart-required change warns that the Drivers API must restart',
    { tag: '@write' },
    async ({ page, shell, request }) => {
      test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to read the stored value.');
      const api = new ServiceSettingsApi(AdminApi.asAdmin(request));
      const original = (await api.setting('drivers-api', CLIENT_IDS)).value;
      const before: string[] = original ? JSON.parse(original) : [];
      const added = 'e2e-qc1000-client';
      const settings = new ServiceSettingsPage(page);

      try {
        await settings.open('drivers-api');
        await settings.expand('Identity');
        await expect(settings.restartBadge(CLIENT_IDS)).toBeVisible();
        await expect(settings.listItems(CLIENT_IDS)).toHaveCount(before.length);
        await settings.addListItem(CLIENT_IDS, added);
        await settings.save('Identity');
        await shell.expectStatus('Settings saved. 1 of them take effect only after the Drivers API restarts.', 'warning');
        expect(JSON.parse(storedValue('drivers-api', CLIENT_IDS)!)).toEqual([...before, added]);

        await settings.open('drivers-api');
        await settings.expand('Identity');
        await expect(settings.listItems(CLIENT_IDS)).toHaveCount(before.length + 1);
        await settings.removeListItem(CLIENT_IDS, added);
        await settings.save('Identity');
        await shell.expectStatus(/take effect only after the Drivers API restarts/, 'warning');
        expect(storedValue('drivers-api', CLIENT_IDS)).toBe(original);
      } finally {
        if ((await api.setting('drivers-api', CLIENT_IDS)).value !== original) await api.restore('drivers-api', { [CLIENT_IDS]: original });
      }
    },
  );

  test(
    'SSET-05 a secret is set and cleared on the page, is never shown or sent back, survives a save of its group without being retyped, and is logged without its value',
    { tag: '@write' },
    async ({ page, shell, request }) => {
      test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to check the stored secret.');
      test.skip(storedValue('drivers-api', EXPO_TOKEN) !== null, 'Push:ExpoAccessToken already holds a value; the run never overwrites a real secret.');
      const api = new ServiceSettingsApi(AdminApi.asAdmin(request));
      const probe = `e2e-qc1000-${randomBytes(12).toString('hex')}`;
      const pushEnabled = (await api.setting('drivers-api', PUSH_ENABLED)).value;
      const since = lastChangeLogId();
      const actor = adminAccount()!.email;
      const settings = new ServiceSettingsPage(page);

      try {
        await settings.open('drivers-api');
        await settings.expand('Push');
        await expect(settings.secretState(EXPO_TOKEN)).toHaveText('Not set');
        await expect(settings.secretClear(EXPO_TOKEN)).toHaveCount(0);
        await settings.secretReplace(EXPO_TOKEN).click();
        await expect(settings.input(EXPO_TOKEN)).toHaveAttribute('type', 'password');
        await settings.input(EXPO_TOKEN).fill(probe);
        await settings.save('Push');
        await shell.expectStatus('Settings saved.');

        await expect(settings.secretState(EXPO_TOKEN)).toHaveText('Set');
        await expect(settings.input(EXPO_TOKEN)).toHaveCount(0);
        expect(storedValue('drivers-api', EXPO_TOKEN)).toBe(probe);
        const fromApi = await api.setting('drivers-api', EXPO_TOKEN);
        expect(fromApi).toMatchObject({ value: null, hasValue: true });
        expect((await AdminApi.asAdmin(request).get('/service-settings/drivers-api')).text).not.toContain(probe);

        await settings.toggle(PUSH_ENABLED).click();
        await settings.save('Push');
        await shell.expectStatus('Settings saved.');
        expect(storedValue('drivers-api', EXPO_TOKEN), 'saving the group without retyping keeps the secret').toBe(probe);

        await settings.open('drivers-api');
        await settings.expand('Push');
        await expect(settings.root).not.toContainText(probe);
        await settings.secretClear(EXPO_TOKEN).click();
        await expect(settings.confirmDialog.title).toHaveText('Clear expo access token?');
        await settings.confirmDialog.accept();
        await shell.expectStatus('Settings saved.');
        await expect(settings.secretState(EXPO_TOKEN)).toHaveText('Not set');
        expect(storedValue('drivers-api', EXPO_TOKEN)).toBeNull();

        const rows = activity('drivers-api', since);
        expect(rows.filter((row) => row.summary.includes(EXPO_TOKEN))).toEqual([
          { summary: `Changed ${EXPO_TOKEN} (secret)`, createdBy: actor },
          { summary: `Cleared ${EXPO_TOKEN} (secret)`, createdBy: actor },
        ]);
        expect(
          rows.some((row) => row.summary.includes(probe)),
          'no activity row holds the secret',
        ).toBe(false);
      } finally {
        if (storedValue('drivers-api', EXPO_TOKEN) !== null) await api.save('drivers-api', {}, [EXPO_TOKEN]);
        if ((await api.setting('drivers-api', PUSH_ENABLED)).value !== pushEnabled) await api.restore('drivers-api', { [PUSH_ENABLED]: pushEnabled });
      }
      expect(storedValue('drivers-api', EXPO_TOKEN)).toBeNull();
    },
  );

  test(
    'SSET-06 the API refuses bad values by type keyed by setting id, an empty required value and an unknown id, and stores nothing',
    { tag: '@write' },
    async ({ request }) => {
      test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to prove nothing was saved.');
      const admin = AdminApi.asAdmin(request);
      const api = new ServiceSettingsApi(admin);
      const drivers = await api.all('drivers-api');
      const identity = await api.all('identity');
      const since = lastChangeLogId();

      const cases: [ServiceSlug, string, string, string][] = [
        ['drivers-api', COALESCE, 'five', 'Use a whole number.'],
        ['drivers-api', 'DriverLocation:CleanupRadiusMeters', 'wide', 'Use a number.'],
        ['drivers-api', 'Swagger:Enabled', 'yes', 'Use true or false.'],
        ['drivers-api', 'Ocr:Url', 'ftp://ocr.example', 'Use a full http or https address.'],
        ['drivers-api', 'Messaging:DriversUuid', 'not-a-guid', 'Use a GUID like 00000000-0000-0000-0000-000000000000.'],
        ['drivers-api', CORS, '{"origin":"x"}', 'Use a list of single-line values.'],
        ['drivers-api', 'Identity:Audience', '', 'A value is required.'],
        ['drivers-api', 'Messaging:QueueName', 'two\nlines', 'Use a single line.'],
        ['identity', 'Invites:MaxLifetime', 'a day', 'Use a time span like 00:05:00 or 1.00:00:00.'],
      ];

      for (const [service, key, value, message] of cases) {
        const uuid = (service === 'identity' ? identity : drivers).get(key)!.settingUuid;
        const result = await admin.put(`/service-settings/${service}`, { values: { [uuid]: value }, clears: [] });
        expect(result.status, `${key} = '${value}'`).toBe(400);
        expect(result.body.errors[uuid], `${key} = '${value}'`).toEqual([message]);
      }

      const audience = drivers.get('Identity:Audience')!.settingUuid;
      const cleared = await admin.put('/service-settings/drivers-api', { values: {}, clears: [audience] });
      expect(cleared.status).toBe(400);
      expect(cleared.body.errors[audience]).toEqual(['A value is required.']);
      expect((await admin.put('/service-settings/drivers-api', { values: {}, clears: [] })).status).toBe(400);
      expect((await admin.put('/service-settings/drivers-api', { values: { '00000000-0000-0000-0000-000000000000': '1' } })).status).toBe(400);
      const crossed = await admin.put('/service-settings/identity', { values: { [drivers.get(COALESCE)!.settingUuid]: '6' } });
      expect(crossed.status, 'a Drivers API id is unknown on the Identity tab').toBe(400);

      const unchanged = await api.save('drivers-api', { [COALESCE]: drivers.get(COALESCE)!.value });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body).toMatchObject({ updatedCount: 0, restartRequiredKeys: [], message: 'Nothing changed.' });

      for (const [key, setting] of drivers) {
        if (!setting.isSensitive) expect(storedValue('drivers-api', key), key).toBe(setting.value);
      }
      expect(lastChangeLogId(), 'no activity row').toBe(since);
    },
  );

  test(
    'SSET-07 an Identity live setting saves on the Identity tab and is logged under the Identity area',
    { tag: '@write' },
    async ({ page, shell, request }) => {
      test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to read the activity rows.');
      const api = new ServiceSettingsApi(AdminApi.asAdmin(request));
      const original = (await api.setting('identity', SENDER_NAME)).value;
      const probe = `E2E QC-1000 ${Date.now()}`;
      const since = lastChangeLogId();
      const settings = new ServiceSettingsPage(page);

      try {
        await settings.open('identity');
        await settings.expand('EmailSettings');
        await settings.input(SENDER_NAME).fill(probe);
        await settings.save('EmailSettings');
        await shell.expectStatus('Settings saved.');
        expect(storedValue('identity', SENDER_NAME)).toBe(probe);
        expect(activity('identity', since)).toEqual([
          { summary: `Changed ${SENDER_NAME} from ${original ?? '(default)'} to ${probe}`, createdBy: adminAccount()!.email },
        ]);
        expect(activity('drivers-api', since)).toEqual([]);
      } finally {
        if ((await api.setting('identity', SENDER_NAME)).value !== original) await api.restore('identity', { [SENDER_NAME]: original });
      }
      expect(storedValue('identity', SENDER_NAME)).toBe(original);
    },
  );

  test("SSET-08 a person's admin token cannot read the Drivers API or Identity service settings feeds", async ({ request }) => {
    const admin = AdminApi.asAdmin(request);
    expect((await admin.get('/drivers/settings')).status).toBe(403);
    expect((await admin.get('/identity/service-settings')).status).toBe(403);
  });

  test.describe('without a token', () => {
    test.use(signedOut);

    test('SSET-09 the service settings and both reader feeds refuse anonymous calls', async ({ request }) => {
      const anonymous = new AdminApi(request, null);
      for (const target of ['/service-settings/drivers-api', '/service-settings/identity', '/drivers/settings', '/identity/service-settings']) {
        expect((await anonymous.get(target)).status, target).toBe(401);
      }
      expect((await anonymous.put('/service-settings/drivers-api', { values: {}, clears: [] })).status).toBe(401);
    });
  });
});
