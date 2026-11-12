import { randomUUID } from 'crypto';
import { test, expect } from '@fixtures/pageFixtures';
import { adminUrl } from '@pages/admin-shell.page';
import type { NewHost } from '@pages/host-management.page';
import { environmentSettings } from '@pages/setting-template.page';
import {
  QC912_HOST_KEY_PREFIX,
  QC912_HOST_NAME_PREFIX,
  QC912_REMOVE_SCRIPT,
  deactivatedHostUuid,
  hostDatabaseHostUuid,
  hostEnvironmentSettingHash,
  masterHostCount,
  masterHostEnvironmentRows,
  masterHostReady,
  masterHostReadyAt,
  masterHostWithApi,
  masterHostsWithUuid,
  setMasterHostReadyAt,
} from '@pages/host-existing-uuid.page';
import { HostExistingUuidApi } from '@api/host-existing-uuid.api';
import { canSeedLocalDb, canUseMasterDb, runMasterSeedScript } from '@utils/localDb';
import { canUseAdminApi } from '@api/admin.api';

const UUID_TAKEN = 'A host with this UUID is already in HOST_MASTER, active or removed.';
const UUID_EMPTY = "Enter the host's existing UUID, or leave it blank for a new one.";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function qc912Host(label: string, overrides: Partial<NewHost> = {}): NewHost {
  const stamp = `${label}${Date.now().toString(36)}`;
  return {
    name: `${QC912_HOST_NAME_PREFIX} ${stamp}`,
    hostKey: `${QC912_HOST_KEY_PREFIX}-${stamp}`,
    clientId: `${QC912_HOST_KEY_PREFIX}.${stamp}`,
    databaseName: 'QuarryConnect_Dev_QC912',
    organisationId: '30',
    uiUrl: 'http://localhost:4298',
    ...overrides,
  };
}

test.describe('Add host with an existing host UUID (QC-912)', { tag: ['@regression'] }, () => {
  test.beforeAll(() => {
    if (canUseMasterDb()) runMasterSeedScript(QC912_REMOVE_SCRIPT);
  });

  test.afterAll(() => {
    if (canUseMasterDb()) runMasterSeedScript(QC912_REMOVE_SCRIPT);
  });

  test('HUID-01 Add host shows the optional Existing host UUID field, and the edit form does not', async ({ hostFormPage, addHostUuidPage, targetHost }) => {
    await hostFormPage.openNew();
    await expect(addHostUuidPage.input).toBeVisible();
    await expect(addHostUuidPage.input).toHaveValue('');
    await expect(addHostUuidPage.label).toHaveText('Existing host UUID (optional)');
    await expect(addHostUuidPage.hint).toContainText('Leave blank for a new host.');
    await expect(addHostUuidPage.clientError).toHaveCount(0);

    await hostFormPage.openDetail(targetHost.uuid);
    await expect(addHostUuidPage.input).toHaveCount(0);
  });

  test('HUID-02 a malformed host UUID is refused in the browser and nothing is created', async ({ page, hostFormPage, addHostUuidPage }) => {
    test.skip(!canUseMasterDb(), 'MASTER_SQL_DATABASE is not set.');
    const before = masterHostCount();
    await hostFormPage.openNew();
    await addHostUuidPage.fillHost(qc912Host('bad'), '1234abcd-not-a-host-uuid');
    const posts = addHostUuidPage.recordHostPosts();

    await hostFormPage.create.click();
    await expect(addHostUuidPage.clientError).toHaveText('Host UUID has characters that are not allowed.');
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    expect(posts, 'no create request was sent').toEqual([]);
    expect(masterHostCount()).toBe(before);
  });

  test("HUID-03 an active host's UUID and a deactivated host's UUID are each refused on the field, and nothing is created", async ({
    page,
    hostFormPage,
    addHostUuidPage,
    targetHost,
  }) => {
    test.skip(!canUseMasterDb(), 'MASTER_SQL_DATABASE is not set.');
    const removed = deactivatedHostUuid();
    const before = masterHostCount();
    const host = qc912Host('dup');
    await hostFormPage.openNew();
    await addHostUuidPage.fillHost(host, targetHost.uuid);
    await addHostUuidPage.expectRefused(hostFormPage.create, UUID_TAKEN);
    await expect(hostFormPage.formError).toContainText('Check the highlighted fields.');
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    expect(masterHostCount()).toBe(before);

    test.skip(removed === null, 'HOST_MASTER has no deactivated host to reuse the UUID of.');
    await addHostUuidPage.input.fill(removed!.toUpperCase());
    await addHostUuidPage.expectRefused(hostFormPage.create, UUID_TAKEN);
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    expect(masterHostCount()).toBe(before);
    expect(masterHostsWithUuid(removed!), 'the removed host is still the only row with its UUID').toBe(1);
  });

  test(
    "HUID-04 a host created with a supplied UUID lands on its page, and when its API address is another host's API, Environment refuses to read it and copies nothing",
    { tag: '@create' },
    async ({ page, env, shell, hostFormPage, addHostUuidPage, hostEnvironmentPage, hostExistingUuidApi }) => {
      test.skip(!canUseMasterDb() || !canSeedLocalDb(), 'The HOST_MASTER and host databases are needed.');
      test.skip(!env.appApiUrl || !canUseAdminApi(), 'APP_API_URL and ADMIN_API_URL are needed.');
      const apiHostUuid = hostDatabaseHostUuid();
      test.skip(!apiHostUuid, "The host database has no Messaging:HostUuid, so its API cannot be told apart from another host's.");
      const uuid = randomUUID();
      const host = qc912Host('new', { apiBaseUrl: `${env.appApiUrl}/` });
      const hostDbBefore = hostEnvironmentSettingHash();

      await hostFormPage.openNew();
      await addHostUuidPage.fillHost(host, `  ${uuid}  `);
      await hostFormPage.create.click();
      await shell.expectStatus(`Host '${host.name}' created.`);
      await expect(page).toHaveURL(adminUrl(`/hosts/${uuid}`));
      await expect(hostFormPage.uuid).toHaveText(uuid);
      expect(masterHostsWithUuid(uuid), 'app.Hosts holds the supplied UUID').toBe(1);
      expect(masterHostReady(uuid)).toBe(false);
      const mirrorBefore = masterHostEnvironmentRows(uuid);
      const otherHost = `belongs to another host: its Messaging:HostUuid is ${apiHostUuid}, not ${uuid}.`;

      await hostEnvironmentPage.open(uuid);
      await expect(hostEnvironmentPage.loadWarning).toContainText(otherHost);
      await expect(hostEnvironmentPage.notice).toContainText('This host is not marked ready yet, so changes are kept in HOST_MASTER');

      const view = await hostExistingUuidApi.environment(uuid);
      expect(view.status, view.text).toBe(200);
      expect(view.body.error).toContain(otherHost);
      expect(view.body.canSave, 'nothing can be saved while the API belongs to another host').toBe(false);
      expect(view.body.driftCount).toBe(0);

      const take = await hostExistingUuidApi.takeHostValues(uuid);
      expect(take.status, take.text).toBe(400);
      expect(take.text).toContain(otherHost);

      expect(masterHostEnvironmentRows(uuid), "none of the other host's settings were copied into this host's mirror").toBe(mirrorBefore);
      expect(masterHostReady(uuid), 'opening Environment does not mark the host ready').toBe(false);
      expect(hostEnvironmentSettingHash(), 'nothing was written to the host database').toBe(hostDbBefore);
    },
  );

  test(
    'HUID-06 a host that is not ready reads its own API on Environment: host values fill in, nothing is missing, and nothing is sent to the host',
    { tag: '@write' },
    async ({ env, hostEnvironmentPage, hostExistingUuidApi }) => {
      test.skip(!canUseMasterDb() || !canSeedLocalDb(), 'The HOST_MASTER and host databases are needed.');
      test.skip(!env.appApiUrl || !canUseAdminApi(), 'APP_API_URL and ADMIN_API_URL are needed.');
      const apiHostUuid = hostDatabaseHostUuid();
      const uuid = apiHostUuid ? masterHostWithApi(apiHostUuid, `${env.appApiUrl}/`) : null;
      test.skip(!uuid, "No active HOST_MASTER host has the host database's Messaging:HostUuid and APP_API_URL.");
      const readyAt = masterHostReadyAt(uuid!);
      const hostDbBefore = hostEnvironmentSettingHash();

      setMasterHostReadyAt(uuid!, null);
      try {
        await hostEnvironmentPage.open(uuid!);
        await expect(hostEnvironmentPage.notice).toContainText('This host is not marked ready yet, so changes are kept in HOST_MASTER');
        await expect(hostEnvironmentPage.loadWarning).toHaveCount(0);
        await expect(hostEnvironmentPage.rows().first()).toBeAttached();

        const view = await hostExistingUuidApi.environment(uuid!);
        expect(view.status, view.text).toBe(200);
        expect(view.body.error).toBeNull();
        expect(view.body.canSave).toBe(true);
        const blankRequired = environmentSettings(view.body)
          .filter((s) => s.isHostSpecific && s.isRequired && !s.hasValue)
          .map((s) => s.configurationKey);
        expect(blankRequired, 'every required host-specific value was filled from the host').toEqual([]);

        const readiness = await hostExistingUuidApi.readiness(uuid!);
        expect(readiness.status, readiness.text).toBe(200);
        expect(readiness.body).toMatchObject({ isReady: false, hasApiBaseUrl: true });
        expect(readiness.body.missing, 'no host-specific setting is missing').toEqual([]);

        const take = await hostExistingUuidApi.takeHostValues(uuid!);
        expect(take.status, take.text).toBe(200);

        expect(masterHostReady(uuid!), 'reading Environment does not mark the host ready').toBe(false);
        expect(hostEnvironmentSettingHash(), 'nothing was written to the host database').toBe(hostDbBefore);
      } finally {
        setMasterHostReadyAt(uuid!, readyAt);
      }
      expect(masterHostReadyAt(uuid!), 'ReadyAt is back as it was').toBe(readyAt);
    },
  );

  test('HUID-05 the API refuses an empty UUID on its field and gives a blank one a new random UUID', { tag: '@create' }, async ({ hostExistingUuidApi }) => {
    test.skip(!canUseAdminApi() || !canUseMasterDb(), 'ADMIN_API_URL and MASTER_SQL_DATABASE are needed.');
    const before = masterHostCount();
    const input = (host: NewHost) => ({
      name: host.name,
      hostKey: host.hostKey,
      clientId: host.clientId,
      databaseName: host.databaseName,
      uiUrl: host.uiUrl,
      apiBaseUrl: null,
      hostOrganisationId: Number(host.organisationId),
    });

    const empty = await hostExistingUuidApi.createHost({ ...input(qc912Host('empty')), hostUuid: '00000000-0000-0000-0000-000000000000' });
    expect(empty.status, empty.text).toBe(400);
    expect(HostExistingUuidApi.fieldError(empty.body, 'hostUuid')).toBe(UUID_EMPTY);
    expect(masterHostCount()).toBe(before);

    const blank = await hostExistingUuidApi.createHost({ ...input(qc912Host('blank')), hostUuid: null });
    expect([200, 201], blank.text).toContain(blank.status);
    const uuid = String(blank.body.hostUuid);
    expect(uuid).toMatch(GUID);
    expect(uuid).not.toBe('00000000-0000-0000-0000-000000000000');
    expect(masterHostsWithUuid(uuid)).toBe(1);
    expect(masterHostCount()).toBe(before + 1);
  });
});
