import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, runIdentitySeedScript, runMasterSeedScript } from '../fixtures/localDb';
import { AdminApi, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { authorizeRedirect } from '../pages/IdentityAdminApi';
import { HostEnvironmentPage, HostFeaturesPage, HostFormPage, HostListPage, HostUsersPage, UserDetailPage } from '../pages/HostManagementPages';
import { UserListPage } from '../pages/UserListPage';
import { env } from '../config/environment';

const MEMBER = 'e2e.qc739.member@quarryconnect.test';
const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';
const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

test.describe('Hosts (QC-739, Angular since QC-742)', () => {
  test('HM-01 the hosts list links each host by its UUID and shows the Identity link', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const list = new HostListPage(page);
    await list.open();
    const row = list.row(targetHost.uuid);
    await expect(row).toContainText(targetHost.name);
    await expect(row.locator('[data-testid="host-identity"]')).toHaveText('Linked');
    await expect(list.link(targetHost.uuid)).toHaveAttribute('href', `#/hosts/${targetHost.uuid}`);
  });

  test("HM-02 a host's page shows its UUID and its Identity clients, never a numeric id", async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    await expect(form.facts).toContainText(targetHost.uuid);
    await expect(form.identityPanel).toContainText('is active');
    await expect(form.identityClients.first()).toBeVisible();
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

  test.describe('creation rollback', { tag: '@write' }, () => {
    test.skip(!canUseIdentityDb(), "Needs Identity's local database to prove nothing was left behind.");

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc739.remove.sql');
    });

    test('HM-04 when Identity refuses the sign-in client, the Identity host it just made is removed and HOST_MASTER is untouched', async ({ page }) => {
      const list = new HostListPage(page);
      await list.open();
      const registered = await list.clientIds();
      const identityClients = (queryIdentityDb("SELECT STRING_AGG(ClientId, ',') FROM Clients WHERE ClientId LIKE 'host.%'") ?? '').split(',');
      const taken = identityClients.find((clientId) => clientId && !registered.includes(clientId));
      test.skip(!taken, 'Every Identity host client is also registered in HOST_MASTER, so none can collide in Identity alone.');

      const form = new HostFormPage(page);
      await form.openNew();
      await form.fill({
        name: 'E2E QC-739 rollback',
        hostKey: 'e2e-qc739-rollback',
        clientId: taken!,
        databaseName: 'QuarryConnect_Dev',
        organisationId: '99',
        uiUrl: 'http://localhost:4298',
      });
      await form.create.click();

      await expect(form.formError).toContainText("Identity refused the host's sign-in client");
      await expect(page).toHaveURL(adminUrl('/hosts/new'));
      await expect(form.error('clientId')).toContainText('already exists');
      expect(queryIdentityDb("SELECT COUNT(*) FROM app.Hosts WHERE HostKey = 'e2e-qc739-rollback'")).toBe('0');

      await list.open();
      await expect(list.table).not.toContainText('E2E QC-739 rollback');
    });
  });

  test.describe('a created host', () => {
    test.afterAll(() => {
      if (canUseIdentityDb()) runIdentitySeedScript('identity-qc739.remove.sql');
      if (canUseMasterDb()) runMasterSeedScript('master-e2e-hosts.remove.sql');
    });

    test('HM-05 a created host can be signed into at once, and deactivating it after confirming stops sign-in', { tag: '@create' }, async ({ page, request, shell }) => {
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
      await shell.expectStatus('can be signed into now');
      await expect(form.identityClient(clientId)).toBeVisible();

      const query = { client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: `${uiUrl}/`, ...PKCE };
      expect(await authorizeRedirect(request, query)).toMatch(/\/Account\/Login/i);

      await form.deactivate.click();
      await form.confirmDialog.accept();
      await expect(page).toHaveURL(adminUrl('/hosts'));
      await shell.expectStatus('Nobody can sign in to it any more.');
      expect(await authorizeRedirect(request, query)).toMatch(/\/Error\?errorId=/);
    });
  });
});

test.describe('Host features (QC-739, Angular since QC-742)', () => {
  test('HF-01 product features come from the host API with their rules, and MFA from Identity', { tag: '@smoke' }, async ({ page, targetHost }) => {
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
    expect(dependency.text).toContain('Statewide dispatch needs Dispatch to be on.');

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
      await expect(features.row('maps')).toContainText(`Changed by ${env.admin!.email}`);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }
  });

  test('HF-05 the MFA switch saves through Identity', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.mfaOn();

    try {
      await features.setMfa(!original);
      await features.mfaSave.click();
      await shell.expectStatus(original ? 'no longer required' : 'now required');
      await features.open(targetHost.uuid);
      await expect(features.mfa).toHaveAttribute('aria-checked', String(!original));
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.mfaOn()) !== original) {
        await features.setMfa(original);
        await features.mfaSave.click();
        await shell.expectStatus(/required at this host/);
      }
    }
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
      await expect(secret).toHaveValue('');
    }
    await expect(environment.secretStates().first()).toHaveText(/^\s*(Set|Not set)\s*$/);
  });

  test('HE-02 a value of the wrong type is refused on its own row and nothing is saved', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();

    await environment.input(SAFE_SETTING).fill('not-a-number');
    await environment.save.click();
    await expect(environment.error(SAFE_SETTING)).toContainText('whole number');

    await environment.open(targetHost.uuid);
    await expect(environment.input(SAFE_SETTING)).toHaveValue(original);
  });

  test('HE-03 a changed setting is saved alone and flags that the host API needs a restart', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const original = await environment.input(SAFE_SETTING).inputValue();
    const probe = original === '21' ? '22' : '21';

    try {
      await environment.input(SAFE_SETTING).fill(probe);
      await environment.save.click();
      await shell.expectStatus('Saved 1 setting.', 'warning');
      await shell.expectStatus(SAFE_SETTING, 'warning');
      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);

      await environment.save.click();
      await shell.expectStatus('Nothing has changed.', 'info');
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.input(SAFE_SETTING).fill(original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.', 'warning');
      }
    }
  });

  test('HE-04 restart waits for confirmation in a dialog that names the host', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restart.click();
    await expect(environment.confirmDialog.root).toBeVisible();
    await expect(environment.confirmDialog.message).toContainText(`${targetHost.name}'s API will be unavailable while it restarts.`);
    await expect(environment.confirmDialog.confirm).toHaveText('Restart now');
    await expect(environment.confirmDialog.confirm).toHaveClass(/daxa-danger/);
    await environment.confirmDialog.dismiss();
  });
});

test.describe('Host users (QC-739, Angular since QC-742)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canUseIdentityDb(), "Needs Identity's local database to seed and remove the throwaway member user.");

  test.beforeAll(() => {
    runIdentitySeedScript('identity-qc739-member.apply.sql');
  });

  test.afterAll(() => {
    runIdentitySeedScript('identity-qc739.remove.sql');
  });

  test('HU-01 an existing user is found and added to the host with a role', async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid, 'e2e.qc739.member');
    await users.add(MEMBER, 'HostUser');
    await shell.expectStatus(`can now sign in to ${targetHost.name} as HostUser`);
    await expect(users.role(MEMBER)).toHaveText('HostUser');
    await expect(page).toHaveURL(adminUrl(`/hosts/${targetHost.uuid}/users`));

    await users.open(targetHost.uuid, 'e2e.qc739.member');
    await expect(users.candidate(MEMBER).locator('[data-testid="candidate-mapped"]')).toHaveText('Already at this host');
  });

  test("HU-02 changing the role and host-admin flag updates only this host's mapping", async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.update(MEMBER, 'Driver', true);
    await shell.expectStatus('is now Driver and a host admin');
    await users.open(targetHost.uuid);
    await expect(users.role(MEMBER)).toHaveText('Driver');
    await expect(users.hostAdmin(MEMBER)).toBeChecked();
    expect(queryIdentityDb(`SELECT COUNT(*) FROM app.UserHosts m JOIN Users u ON u.Id = m.UserID WHERE u.Email = ${sqlText(MEMBER)} AND m.Active = 1`)).toBe('1');
  });

  test('HU-03 the user page lists the host, and the account is switched off and on after confirming, without touching the mapping', async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.memberLink(MEMBER).click();
    await expect(page).toHaveURL(/#\/users\/[0-9a-f-]{36}$/i);

    const detail = new UserDetailPage(page);
    await expect(detail.hosts).toContainText(targetHost.name);
    await expect(detail.state).toHaveText('Account active');

    await detail.deactivate.click();
    await detail.confirmDialog.dismiss();
    await expect(detail.state).toHaveText('Account active');

    await detail.setActive(false);
    await shell.expectStatus('host mappings are kept');
    await expect(detail.state).toHaveText('Account deactivated');
    await expect(detail.hosts).toContainText(targetHost.name);

    await detail.setActive(true);
    await shell.expectStatus('active again');
    await expect(detail.state).toHaveText('Account active');
  });

  test('HU-04 removing the last host mapping after confirming leaves the account active', async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.remove(MEMBER);
    await shell.expectStatus('not mapped to any host now, but their account is still active');
    await expect(users.member(MEMBER)).toHaveCount(0);
    expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Email = ${sqlText(MEMBER)}`)).toBe('1');
  });

  test('HU-05 the Users page finds a user and links to them by their Identity id', async ({ page }) => {
    const list = new UserListPage(page);
    await list.open({ search: 'e2e.qc739.member' });
    const link = list.rowByEmail(MEMBER).locator('[data-testid="user-name"]');
    await expect(link).toHaveText('E2E QC-739 Member');
    await expect(link).toHaveAttribute('href', /^#\/users\/[0-9a-f-]{36}$/i);
  });
});
