import { test, expect } from '../fixtures/test';
import { canUseMasterDb, queryMasterDb } from '../fixtures/localDb';
import { AdminApi, canUseAdminApi } from '../pages/AdminApi';
import { HostFeaturesPage } from '../pages/HostManagementPages';
import { HostNav } from '../pages/HostPages';

function masterFeature(uuid: string, key: string): string | null {
  return queryMasterDb(
    `SELECT CAST(f.IsEnabled AS varchar(1)) FROM app.HostFeatures f JOIN app.Hosts h ON h.HostID = f.HostID_FK WHERE h.HostUUID = '${uuid}' AND f.Active = 1 AND f.FeatureKey = N'${key}'`,
  );
}

test.describe('Feature switches (QC-742)', () => {
  test('FEAT-00 the features page lists the product features with their rules, and the MFA switch', { tag: '@smoke' }, async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    await expect(new HostNav(page).tab('features')).toHaveClass(/active/);
    await expect(page.locator('.qc-kpi, .qc-kpi-grid')).toHaveCount(0);
    expect(await features.featureKeys()).toEqual(expect.arrayContaining(['quickbooks', 'sage', 'dispatch', 'dispatch_statewide', 'maps']));
    await expect(features.feature('sage')).toHaveAttribute('data-exclusive', 'quickbooks');
    await expect(features.feature('dispatch_statewide')).toHaveAttribute('data-requires', 'dispatch');
    await expect(features.mfaForm).toBeVisible();
    await expect(features.mfa).toHaveAttribute('aria-checked', /^(true|false)$/);
  });

  test('FEAT-01 QuickBooks on locks Sage off, and switching QuickBooks off frees it', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    test.skip(await features.isOn('sage'), 'Sage is on at this host, so QuickBooks is the locked one.');

    await features.setOn('quickbooks', true);
    await expect(features.checkbox('sage')).not.toBeChecked();
    await expect(features.checkbox('sage')).toBeDisabled();
    await expect(features.row('sage')).toHaveClass(/locked/);

    await features.setOn('quickbooks', false);
    await expect(features.checkbox('sage')).toBeEnabled();
    await expect(features.row('sage')).not.toHaveClass(/locked/);
  });

  test('FEAT-02 switching Dispatch off switches Statewide dispatch off and locks it', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);

    await features.setOn('dispatch', true);
    await features.setOn('dispatch_statewide', true);
    await features.setOn('dispatch', false);
    await expect(features.checkbox('dispatch_statewide')).not.toBeChecked();
    await expect(features.checkbox('dispatch_statewide')).toBeDisabled();

    await features.setOn('dispatch', true);
    await expect(features.checkbox('dispatch_statewide')).toBeEnabled();
    await expect(features.checkbox('dispatch_statewide')).not.toBeChecked();
  });

  test('FEAT-03 the Admin API refuses a set that breaks a rule even when the page is bypassed, and nothing changes', { tag: '@write' }, async ({ page, request, targetHost }) => {
    test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const before = await features.enabledKeys();
    const api = AdminApi.asAdmin(request);

    const exclusive = await api.put(`/hosts/${targetHost.uuid}/features/product`, { enabled: [...new Set([...before, 'quickbooks', 'sage'])] });
    expect(exclusive.status).toBe(400);
    expect(exclusive.body.detail).toBe('These features cannot be combined.');
    expect(Object.values(exclusive.body.errors).flat()).toContain('QuickBooks and Sage cannot both be on.');

    const dependency = await api.put(`/hosts/${targetHost.uuid}/features/product`, { enabled: [...before.filter((k) => k !== 'dispatch'), 'dispatch_statewide'] });
    expect(dependency.status).toBe(400);
    expect(Object.values(dependency.body.errors).flat()).toContain('Statewide dispatch needs Dispatch to be on.');

    await features.open(targetHost.uuid);
    expect((await features.enabledKeys()).sort()).toEqual([...before].sort());
  });

  test('FEAT-04 switching Maps saves through the host API, reaches HOST_MASTER and survives a reload', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const original = await features.isOn('maps');

    try {
      await test.step('flip Maps and save', async () => {
        await features.setOn('maps', !original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      });

      await test.step('value persists after a reload', async () => {
        await features.open(targetHost.uuid);
        await expect(features.checkbox('maps')).toBeChecked({ checked: !original });
      });

      if (canUseMasterDb()) {
        expect(masterFeature(targetHost.uuid, 'maps')).toBe(original ? '0' : '1');
      }
    } finally {
      await features.open(targetHost.uuid);
      if ((await features.isOn('maps')) !== original) {
        await features.setOn('maps', original);
        await features.save.click();
        await shell.expectStatus('Saved 1 feature change.');
      }
    }

    if (canUseMasterDb()) {
      expect(masterFeature(targetHost.uuid, 'maps')).toBe(original ? '1' : '0');
    }
  });

  test('FEAT-05 each rule is spelled out next to its feature', async ({ page, targetHost }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    await expect(features.rule('dispatch_statewide')).toContainText('Needs Dispatch.');
    await expect(features.rule('sage')).toContainText('Not with QuickBooks.');
    await expect(features.rule('maps')).toHaveText('');
  });

  test('FEAT-06 saving with nothing changed says so, sends the saved set to the host again and changes nothing', { tag: '@write' }, async ({ page, targetHost, shell }) => {
    const features = new HostFeaturesPage(page);
    await features.open(targetHost.uuid);
    const before = await features.enabledKeys();
    await features.save.click();
    await shell.expectStatus('No changes. The host has them now.');
    await features.open(targetHost.uuid);
    expect(await features.enabledKeys()).toEqual(before);
  });
});
