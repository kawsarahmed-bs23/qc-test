import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, canUseMasterDb, queryMasterDb, runIdentitySeedScript, runMasterSeedScript } from '../fixtures/localDb';
import { adminUrl } from '../pages/AdminShell';
import { HostFeaturesPage, HostFormPage, HostListPage } from '../pages/HostManagementPages';
import { HostNav } from '../pages/HostPages';

test.describe('Hosts: list, add, details (QC-742)', () => {
  test('HOST-01 the hosts list shows the target host with its key, client, database, Identity link and host API', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const list = new HostListPage(page);
    await list.open();
    const row = list.row(targetHost.uuid);
    await expect(list.link(targetHost.uuid)).toHaveText(targetHost.name);
    await expect(list.link(targetHost.uuid)).toHaveAttribute('href', `#/hosts/${targetHost.uuid}`);
    await expect(row.locator('[data-testid="host-identity"]')).toHaveText(/^(Linked|Not linked)$/);
    await expect(row.locator('[data-testid="host-api"]')).toHaveText(/^(Set|Not set)$/);
    await expect(row.locator('td')).toHaveCount(6);
  });

  test('HOST-02 a host page shows its UUID, key and sign-in client, and its URL carries only the UUID', async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    await expect(form.uuid).toHaveText(targetHost.uuid);
    await expect(form.hostKey).not.toHaveText('');
    await expect(form.clientId).not.toHaveText('');
    await expect(form.field('Name')).toHaveValue(targetHost.name);
    await expect(form.field('HostKey')).toHaveCount(0);
    await expect(form.field('ClientId')).toHaveCount(0);
    expect(page.url()).toBe(adminUrl(`/hosts/${targetHost.uuid}`));
    expect(page.url()).not.toMatch(/\/hosts\/\d+(\/|$)/);
  });

  test('HOST-03 Add host refuses an existing name and sign-in client and creates nothing', { tag: '@write' }, async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    const clientId = (await form.clientId.innerText()).trim();
    const before = canUseMasterDb() ? queryMasterDb('SELECT COUNT(*) FROM app.Hosts') : null;

    await form.openNew();
    await form.fill({
      name: targetHost.name,
      hostKey: 'e2e-qc742-duplicate',
      clientId,
      databaseName: 'QuarryConnect_Dev',
      organisationId: '30',
      uiUrl: 'http://localhost:4295',
    });
    await form.create.click();

    await expect(form.formError).toContainText('Check the highlighted fields.');
    await expect(page).toHaveURL(adminUrl('/hosts/new'));
    await expect(form.error('name')).toHaveText('Another host already has this name.');
    await expect(form.error('clientId')).toHaveText('Another host already uses this sign-in client.');
    if (before !== null) {
      expect(queryMasterDb('SELECT COUNT(*) FROM app.Hosts')).toBe(before);
    }
  });

  test('HOST-04 Add host checks required fields and the host key in the browser before sending anything', async ({ page }) => {
    const form = new HostFormPage(page);
    await form.openNew();
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/hosts')) posts.push(request.url());
    });

    await form.create.click();
    for (const [field, label] of [['Name', 'Name'], ['HostKey', 'Host key'], ['ClientId', 'Sign-in client id'], ['DatabaseName', 'Database name'], ['UiUrl', 'Host app address']] as const) {
      await expect(form.clientError(field)).toHaveText(`${label} is required.`);
    }

    await form.field('HostKey').fill('Not A Key');
    await form.field('HostOrganisationId').fill('0');
    await form.create.click();
    await expect(form.clientError('HostKey')).toHaveText('Host key has characters that are not allowed.');
    await expect(form.clientError('HostOrganisationId')).toHaveText('Host organisation id must be 1 or more.');

    await form.cancel.click();
    await expect(page).toHaveURL(adminUrl('/hosts'));
    expect(posts, 'no create request was sent').toEqual([]);
  });

  test.describe('a created host', () => {
    test.afterAll(() => {
      if (canUseIdentityDb()) runIdentitySeedScript('identity-qc742.remove.sql');
      if (canUseMasterDb()) runMasterSeedScript('master-e2e-hosts.remove.sql');
    });

    test('HOST-05 a created host without a host API is listed as such, explains it on Features, and is deactivated after confirming', { tag: '@create' }, async ({ page, shell }) => {
      const stamp = Date.now().toString(36);
      const name = `E2E QC-742 ${stamp}`;
      const form = new HostFormPage(page);

      await form.openNew();
      await form.fill({
        name,
        hostKey: `e2e-qc742-${stamp}`,
        clientId: `e2e-qc742.web${stamp}`,
        databaseName: 'QuarryConnect_Dev',
        organisationId: '99',
        uiUrl: 'http://localhost:4294',
      });
      await form.create.click();
      await shell.expectStatus(`Host '${name}' created. It can be signed into now.`);
      await expect(page).toHaveURL(/#\/hosts\/[0-9a-f-]{36}$/);
      const uuid = page.url().split('/').pop()!;
      await expect(form.identityState).toHaveText('Linked to Identity');

      const list = new HostListPage(page);
      await list.open();
      await expect(list.row(uuid).locator('[data-testid="host-api"]')).toHaveText('Not set');

      const features = new HostFeaturesPage(page);
      await page.goto(adminUrl(`/hosts/${uuid}/features`));
      await expect(features.productError).toBeVisible();
      await expect(features.save).toHaveCount(0);

      await form.openDetail(uuid);
      await form.deactivate.click();
      await expect(form.confirmDialog.title).toHaveText(`Deactivate ${name}?`);
      await form.confirmDialog.accept();
      await shell.expectStatus(`Host '${name}' deactivated.`);
      await expect(page).toHaveURL(adminUrl('/hosts'));
      await expect(list.row(uuid)).toHaveCount(0);
    });
  });

  test('HOST-06 a host app address without a scheme is refused on its field and nothing is saved', { tag: '@write' }, async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    const original = await form.field('UiUrl').inputValue();

    await form.field('UiUrl').fill('localhost:4200');
    await form.save.click();
    await expect(form.formError).toContainText('Check the highlighted fields.');
    await expect(form.error('uiUrl')).toContainText('http:// or https://');

    await form.openDetail(targetHost.uuid);
    await expect(form.field('UiUrl')).toHaveValue(original);
  });

  test('HOST-07 Deactivate asks first, and Cancel keeps the host', async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/deactivate')) posts.push(request.url());
    });

    await form.deactivate.click();
    await expect(form.confirmDialog.title).toHaveText(`Deactivate ${targetHost.name}?`);
    await expect(form.confirmDialog.message).toContainText('Nobody will be able to sign in');
    await expect(form.confirmDialog.confirm).toHaveText(`Deactivate ${targetHost.name}`);
    await form.confirmDialog.dismiss();

    await expect(page).toHaveURL(adminUrl(`/hosts/${targetHost.uuid}`));
    expect(posts).toEqual([]);
    await form.openDetail(targetHost.uuid);
    await expect(form.uuid).toHaveText(targetHost.uuid);
  });

  test('HOST-08 a linked host shows its Identity host and clients and offers no link picker', async ({ page, targetHost }) => {
    const form = new HostFormPage(page);
    await form.openDetail(targetHost.uuid);
    test.skip((await form.identityState.innerText()).trim() !== 'Linked to Identity', 'The target host is not linked to Identity.');
    await expect(form.linkField).toHaveCount(0);
    await expect(form.identityHostState).toContainText('is active.');
    await expect(form.identityClient((await form.clientId.innerText()).trim())).toBeVisible();
    await expect(new HostNav(page).tab('details')).toHaveClass(/active/);
  });
});
