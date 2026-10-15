import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { authorizeRedirect } from '../pages/IdentityAdminApi';
import { HostEnvironmentPage, HostFeaturesPage, HostFormPage, HostListPage, HostUsersPage, UserDetailPage } from '../pages/HostManagementPages';
import { env } from '../config/environment';

const MEMBER = 'e2e.qc739.member@quarryconnect.test';
const SAFE_SETTING = 'DispatchSnapshot:RateLimitPermitsPerHour';
const PKCE = { code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', code_challenge_method: 'S256' };

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

test.describe('Hosts (QC-739)', () => {
  test('HM-01 the hosts list links each host by its UUID and shows the Identity link', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const list = new HostListPage(page);
    await list.open();
    const row = list.row(targetHost.uuid);
    await expect(row).toContainText(targetHost.name);
    await expect(row).toContainText('Linked');
    await expect(row.locator('a')).toHaveAttribute('href', `/hosts/${targetHost.uuid}`);
  });

  test("HM-02 a host's page shows its UUID and its Identity clients, never a numeric id", async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    await expect(page.locator('.facts')).toContainText(targetHost.uuid);
    await expect(form.identityPanel).toContainText('is active');
    await expect(form.identityPanel.locator('tbody tr').first()).toBeVisible();
    expect(page.url()).not.toMatch(/\/hosts\/\d+(\/|$)/);
  });

  test('HM-03 Add host refuses an existing name, a bad key and addresses without a scheme, and keeps nothing', async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openNew();
    await form.fill({
      name: targetHost.name,
      hostKey: 'Not A Key',
      clientId: 'e2e-qc739.refused',
      databaseName: 'QuarryConnect_Dev',
      organisationId: '30',
      uiUrl: 'localhost:4200',
      apiBaseUrl: 'ftp://example.test',
    });
    await form.submitWithoutBrowserChecks(form.create);

    await expect(page).toHaveURL(/\/hosts\/new$/);
    await expect(form.error('HostKey')).toContainText('lower-case letters');
    await expect(form.error('UiUrl')).toContainText('http:// or https://');
    await expect(form.error('ApiBaseUrl')).toContainText('http:// or https://');

    await form.field('HostKey').fill('e2e-qc739-refused');
    await form.field('UiUrl').fill('http://localhost:4299');
    await form.field('ApiBaseUrl').fill('');
    await form.create.click();
    await expect(form.error('Name')).toHaveText('Another host already has this name.');
  });

  test.describe('creation rollback', { tag: '@write' }, () => {
    test.skip(!canUseIdentityDb(), "Needs Identity's local database to prove nothing was left behind.");

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc739.remove.sql');
    });

    test('HM-04 when Identity refuses the sign-in client, the Identity host it just made is removed and HOST_MASTER is untouched', async ({ page }) => {
      const list = new HostListPage(page);
      await list.open();
      const registered = (await list.table.locator('tbody tr td:nth-child(3)').allInnerTexts()).map((text) => text.trim());
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

      await expect(page).toHaveURL(/\/hosts\/new$/);
      await expect(page.locator('[data-status="error"]')).toContainText("Identity refused the host's sign-in client");
      await expect(form.error('ClientId')).toContainText('already exists');
      expect(queryIdentityDb("SELECT COUNT(*) FROM app.Hosts WHERE HostKey = 'e2e-qc739-rollback'")).toBe('0');

      await new HostListPage(page).open();
      await expect(page.locator('#hosts-table')).not.toContainText('E2E QC-739 rollback');
    });
  });

  test('HM-05 a created host can be signed into at once, and deactivating it stops sign-in', { tag: '@create' }, async ({ page, request }) => {
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

    await expect(page).toHaveURL(/\/hosts\/[0-9a-f-]{36}$/);
    await expect(page.locator('[data-status]')).toContainText('can be signed into now');
    await expect(form.identityPanel).toContainText(clientId);

    const query = { client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: `${uiUrl}/`, ...PKCE };
    expect(await authorizeRedirect(request, query)).toMatch(/\/Account\/Login/i);

    await form.deactivateSummary.click();
    await form.deactivateConfirm.check();
    await form.deactivate.click();
    await expect(page).toHaveURL(/\/hosts$/);
    expect(await authorizeRedirect(request, query)).toMatch(/\/Error\?errorId=/);
  });
});

test.describe('Host features (QC-739)', () => {
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

    await features.feature('dispatch').setChecked(true);
    await features.feature('dispatch_statewide').setChecked(true);
    await features.feature('dispatch').setChecked(false);
    await expect(features.feature('dispatch_statewide')).not.toBeChecked();
    await expect(features.feature('dispatch_statewide')).toBeDisabled();

    await features.feature('sage').setChecked(false);
    await features.feature('quickbooks').setChecked(true);
    await expect(features.feature('sage')).toBeDisabled();
    await features.feature('quickbooks').setChecked(false);
    await expect(features.feature('sage')).toBeEnabled();
  });

  test('HF-03 a direct post that breaks a rule is refused and changes nothing', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const before = await features.enabledKeys();

    const exclusive = await features.postDirect(targetHost.uuid, [...new Set([...before, 'quickbooks', 'sage'])]);
    expect(exclusive.status).toBe(200);
    expect(exclusive.html).toContain('QuickBooks and Sage cannot both be on.');

    const dependency = await features.postDirect(targetHost.uuid, [...before.filter((k) => k !== 'dispatch'), 'dispatch_statewide']);
    expect(dependency.html).toContain('Statewide dispatch needs Dispatch to be on.');

    await features.open(targetHost.uuid);
    expect((await features.enabledKeys()).sort()).toEqual([...before].sort());
  });

  test('HF-04 switching Maps saves through the host API and survives a reload', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.feature('maps').isChecked();

    try {
      await features.feature('maps').setChecked(!original);
      await features.save.click();
      await shell.expectStatus('Saved 1 feature change.');
      await features.open(targetHost.uuid);
      await expect(features.feature('maps')).toBeChecked({ checked: !original });
      await expect(features.feature('maps').locator('xpath=ancestor::li')).toContainText(env.admin!.email);
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.feature('maps').isChecked()) !== original) {
        await features.feature('maps').setChecked(original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }
  });

  test('HF-05 the MFA switch saves through Identity', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.mfa.isChecked();

    try {
      await features.mfa.setChecked(!original);
      await features.mfaSave.click();
      await shell.expectStatus(original ? 'no longer required' : 'now required');
      await expect(features.mfa).toBeChecked({ checked: !original });
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.mfa.isChecked()) !== original) {
        await features.mfa.setChecked(original);
        await features.mfaSave.click();
        await shell.expectStatus(/required at this host/);
      }
    }
  });
});

test.describe('Host environment (QC-739)', () => {
  test('HE-01 secrets are never filled in: each shows only whether it is set', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    const secrets = environment.secretInputs();
    expect(await secrets.count()).toBeGreaterThan(0);
    for (const secret of await secrets.all()) {
      await expect(secret).toHaveAttribute('type', 'password');
      await expect(secret).toHaveValue('');
    }
    await expect(page.locator('[data-secret-state]').first()).toHaveText(/^(Set|Not set)$/);
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
      await shell.expectStatus('Saved 1 setting.');
      await shell.expectStatus(SAFE_SETTING);
      await environment.open(targetHost.uuid);
      await expect(environment.input(SAFE_SETTING)).toHaveValue(probe);

      await environment.save.click();
      await shell.expectStatus('No changes to save.');
    } finally {
      await environment.open(targetHost.uuid);
      if ((await environment.input(SAFE_SETTING).inputValue()) !== original) {
        await environment.input(SAFE_SETTING).fill(original);
        await environment.save.click();
        await shell.expectStatus('Saved 1 setting.');
      }
    }
  });

  test('HE-04 restart waits for the confirmation tick', async ({ page, targetHost }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restartSummary.click();
    await expect(environment.restartConfirm).not.toBeChecked();
    await expect(environment.restartConfirm).toHaveAttribute('required', '');
  });

  test('HE-05 a confirmed restart is requested and reported', { tag: '@restart' }, async ({ page, targetHost, shell }) => {
    const environment = new HostEnvironmentPage(page);
    await environment.open(targetHost.uuid);
    await environment.restartSummary.click();
    await environment.restartConfirm.check();
    await environment.restart.click();
    await shell.expectStatus('Restart requested.');
  });
});

test.describe('Host users (QC-739)', { tag: '@write' }, () => {
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
    await expect(users.role(MEMBER)).toHaveValue('HostUser');

    await users.open(targetHost.uuid, 'e2e.qc739.member');
    await expect(users.candidate(MEMBER)).toContainText('Already at this host');
  });

  test("HU-02 changing the role and host-admin flag updates only this host's mapping", async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.update(MEMBER, 'Driver', true);
    await shell.expectStatus('is now Driver and a host admin');
    await expect(users.role(MEMBER)).toHaveValue('Driver');
    await expect(users.hostAdmin(MEMBER)).toBeChecked();
    expect(queryIdentityDb(`SELECT COUNT(*) FROM app.UserHosts m JOIN Users u ON u.Id = m.UserID WHERE u.Email = ${sqlText(MEMBER)} AND m.Active = 1`)).toBe('1');
  });

  test('HU-03 the user page lists the host, and the account is switched off and on without touching the mapping', async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.member(MEMBER).getByRole('link').click();
    await expect(page).toHaveURL(/\/users\/[0-9a-f-]{36}$/i);

    const detail = new UserDetailPage(page);
    await expect(detail.hosts).toContainText(targetHost.name);
    await expect(detail.state).toHaveText('Account active');

    await detail.setActive(false);
    await shell.expectStatus('host mappings are kept');
    await expect(detail.state).toHaveText('Account deactivated');
    await expect(detail.hosts).toContainText(targetHost.name);

    await detail.setActive(true);
    await shell.expectStatus('active again');
    await expect(detail.state).toHaveText('Account active');
  });

  test('HU-04 removing the last host mapping leaves the account active', async ({ page, targetHost, shell }) => {
    const users = new HostUsersPage(page);
    await users.open(targetHost.uuid);
    await users.remove(MEMBER);
    await shell.expectStatus('not mapped to any host now, but their account is still active');
    await expect(users.member(MEMBER)).toHaveCount(0);
    expect(queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE Email = ${sqlText(MEMBER)}`)).toBe('1');
  });

  test('HU-05 the Users page finds a user and links to them by their Identity id', async ({ page }) => {
    await page.goto('/users?search=e2e.qc739.member');
    const link = page.locator('tbody a', { hasText: 'E2E QC-739 Member' });
    await expect(link).toHaveAttribute('href', /^\/users\/[0-9a-f-]{36}$/i);
  });
});
