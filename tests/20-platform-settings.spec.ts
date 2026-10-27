import * as fs from 'fs';
import * as path from 'path';
import type { Browser } from '@playwright/test';
import { test, expect, signedOut } from '../fixtures/test';
import { env } from '../config/environment';
import { canUseMasterDb, queryMasterDb } from '../fixtures/localDb';
import {
  adminAccount,
  canSeedThrowawayUsers,
  makeQc823PlatformAdmin,
  removeQc823PlatformAdmins,
  removeQc823Users,
  seedQc823User,
  type ThrowawayUser,
} from '../fixtures/throwawayUsers';
import { AdminApi, accessTokenFromPage, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl } from '../pages/AdminShell';
import { IdentityBrandingView, IdentityLoginPage } from '../pages/IdentityLoginPage';
import { decodeJwt } from '../pages/PasswordGrantApi';
import { solidPng, type UploadFile } from '../pages/HostBrandingApi';
import {
  PLATFORM_BRANDING_IMAGES,
  PLATFORM_SETTING_GROUPS,
  PlatformBrandingApi,
  PlatformSettingsApi,
  PlatformSettingsPage,
  canvasJpeg,
  icoFromPng,
  reportScreenshotPath,
  type PlatformImageType,
} from '../pages/PlatformPages';

const REQUIRE_TWO_FACTOR = 'AdminAuth:RequireTwoFactor';
const DISPLAY_NAME = 'Branding:DisplayName';
const LOGIN_SUBTITLE = 'Branding:LoginSubtitle';
const PRIMARY_COLOR = 'Branding:PrimaryColor';
const CACHE_SECONDS = 'HostMaster:CacheDurationSeconds';
const RESET_PER_IP = 'PasswordReset:MaxRequestsPerIpPerHour';
const SWEEP_SECONDS = 'Session:SweepIntervalSeconds';
const IDLE_MINUTES = 'Session:IdleTimeoutMinutes';
const ABSOLUTE_MINUTES = 'Session:AbsoluteTimeoutMinutes';
const SENDER_EMAIL = 'Email:SenderEmail';
const PASSWORD_ONLY_EMAIL = 'e2e.qc823.pwonly@quarryconnect.test';
const PASSWORD_ONLY_NAME = 'E2E QC-823 Password Only';
const DEFAULT_DISPLAY_NAME = 'QuarryConnect Admin';
const IDENTITY_CACHE_FAST = '10';
const IMAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function settingValue(key: string): string | null {
  return queryMasterDb(`SELECT Value FROM app.Settings WHERE SettingKey = N'${key}' AND Active = 1`);
}

function changeLogRows(key: string, since: number): { summary: string; createdBy: string }[] {
  return settingsActivity(`Changed ${key} %`, since);
}

function settingsActivity(like: string, since: number): { summary: string; createdBy: string }[] {
  const output = queryMasterDb(
    `SELECT Summary + N'|' + CreatedBy FROM app.ChangeLogs WHERE ChangeLogID > ${since} AND Area = N'Settings' AND Summary LIKE N'${like}' ORDER BY ChangeLogID`,
  );
  return (output ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const [summary, createdBy] = line.trim().split('|');
      return { summary, createdBy };
    });
}

function storedImageCount(): number {
  return Number(queryMasterDb('SELECT COUNT(*) FROM app.PlatformBrandingImages'));
}

function publicRoutePattern(type: PlatformImageType): RegExp {
  return new RegExp(`^https://[^/]+/api/public/branding/${type}\\?v=\\d{14}$`);
}

async function adminSignInBranding(browser: Browser) {
  const login = await adminLoginPage(browser);
  try {
    const view = new IdentityBrandingView(login.page);
    return {
      logo: (await view.logo.count()) ? await view.logo.getAttribute('src') : null,
      background: (await view.background.count()) ? await view.backgroundImageUrl() : null,
      favicon: await view.favicon.getAttribute('href'),
    };
  } finally {
    await login.context.close();
  }
}

function lastChangeLogId(): number {
  return Number(queryMasterDb('SELECT ISNULL(MAX(ChangeLogID), 0) FROM app.ChangeLogs'));
}

async function adminLoginPage(browser: Browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors, ...signedOut });
  const page = await context.newPage();
  await page.goto(adminUrl('/'));
  await new IdentityLoginPage(page).expectVisible();
  return { context, page };
}

test.describe('Platform settings (QC-823)', () => {
  test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');

  test('PSET-01 the Settings page shows all ten groups in order, the four Admin branding rows with the three image tiles, the restart badge on Sessions rows and none on Identity cache rows', async ({ page, shell }) => {
    const settings = new PlatformSettingsPage(page);
    await page.goto(adminUrl('/'));
    await shell.nav('settings').click();
    await expect(page).toHaveURL(adminUrl('/settings'));
    await expect(shell.heading).toHaveText('Settings');
    await expect(settings.groups.first()).toBeVisible();

    await expect(settings.groups).toHaveCount(PLATFORM_SETTING_GROUPS.length);
    const names = await settings.groups.evaluateAll((cards) => cards.map((card) => card.getAttribute('data-settings-group')));
    expect(names).toEqual(PLATFORM_SETTING_GROUPS);
    for (const group of PLATFORM_SETTING_GROUPS) {
      await expect(settings.group(group)).toBeVisible();
      await expect(settings.saveButton(group)).toBeEnabled();
    }

    await settings.expandAll();
    const sessionRows = settings.group('Sessions').locator('[data-setting-key]');
    await expect(sessionRows).toHaveCount(4);
    for (const row of await sessionRows.all()) {
      await expect(row.locator('[data-testid="setting-restart-required"]')).toHaveText('Restart required');
    }
    const brandingRows = settings.group('Admin branding').locator('[data-setting-key]');
    expect(await brandingRows.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-setting-key')))).toEqual([
      DISPLAY_NAME,
      LOGIN_SUBTITLE,
      PRIMARY_COLOR,
      'Branding:AccentColor',
    ]);
    expect(await settings.imageTiles.evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('data-image')))).toEqual(PLATFORM_BRANDING_IMAGES.map((image) => image.type));
    for (const image of PLATFORM_BRANDING_IMAGES) {
      await expect(settings.imageUpload(image.type)).toHaveAttribute('type', 'file');
    }
    const cacheRows = settings.group('Identity cache').locator('[data-setting-key]');
    await expect(cacheRows).toHaveCount(4);
    await expect(settings.group('Identity cache').locator('[data-testid="setting-restart-required"]')).toHaveCount(0);

    await expect(settings.toggle(REQUIRE_TWO_FACTOR)).toHaveAttribute('aria-checked', 'true');
    await expect(settings.input(DISPLAY_NAME)).toHaveValue(settingValue(DISPLAY_NAME) ?? '');
    await expect(settings.input(IDLE_MINUTES)).toHaveAttribute('type', 'number');
    await expect(settings.input(IDLE_MINUTES)).toHaveAttribute('min', '5');
    await expect(settings.input(IDLE_MINUTES)).toHaveAttribute('max', '1440');

    fs.mkdirSync(path.dirname(reportScreenshotPath('settings.png')), { recursive: true });
    await page.screenshot({ path: reportScreenshotPath('settings.png'), fullPage: true });
  });

  test('PSET-11 each group collapses like the Environment page: only the first is open in a fresh browser, a collapsed group hides its fields, and the open groups are remembered after a reload', async ({ page }) => {
    const settings = new PlatformSettingsPage(page);
    await page.goto(adminUrl('/'));
    await page.evaluate(() => localStorage.removeItem('adminSettings.openGroups'));
    await settings.open(false);

    await expect(page.locator('#settings-accordion')).toBeVisible();
    await expect(settings.header(PLATFORM_SETTING_GROUPS[0])).toHaveAttribute('aria-expanded', 'true');
    for (const group of PLATFORM_SETTING_GROUPS.slice(1)) {
      await expect(settings.header(group)).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(settings.header('Sessions')).toContainText('4 settings');
    await expect(settings.header('Sessions')).toContainText('4 need a restart');
    await expect(settings.input(IDLE_MINUTES)).toBeHidden();

    await settings.expand('Sessions');
    await expect(settings.input(IDLE_MINUTES)).toBeVisible();
    await settings.collapse(PLATFORM_SETTING_GROUPS[0]);
    await expect(settings.toggle(REQUIRE_TWO_FACTOR)).toBeHidden();

    await page.reload();
    await expect(settings.groups.first()).toBeVisible();
    await expect(settings.header('Sessions')).toHaveAttribute('aria-expanded', 'true');
    await expect(settings.header(PLATFORM_SETTING_GROUPS[0])).toHaveAttribute('aria-expanded', 'false');
    await expect(settings.input(IDLE_MINUTES)).toBeVisible();

    await page.evaluate(() => localStorage.removeItem('adminSettings.openGroups'));
  });

  test('PSET-02 GET api/settings returns the 32 catalogue settings in ten groups with their rules and restart flags', async ({ request }) => {
    const groups = await new PlatformSettingsApi(AdminApi.asAdmin(request)).groups();
    expect(groups.map((group) => group.name)).toEqual(PLATFORM_SETTING_GROUPS);
    const settings = groups.flatMap((group) => group.settings);
    expect(settings).toHaveLength(32);
    expect(settings.filter((setting) => setting.isRestartRequired)).toHaveLength(17);
    for (const setting of settings) {
      expect(Object.keys(setting).sort()).toEqual(
        ['settingUuid', 'key', 'value', 'type', 'description', 'isRestartRequired', 'min', 'max', 'maxLength', 'required', 'updatedBy', 'updated'].sort(),
      );
      expect(setting.settingUuid).toMatch(/^[0-9a-f-]{36}$/i);
    }
    const byKey = new Map(settings.map((setting) => [setting.key, setting]));
    expect(byKey.has('Branding:LogoPath'), 'the logo path setting is gone; images are uploaded instead').toBe(false);
    expect([...new Set(settings.map((setting) => setting.type))].sort()).toEqual(['bool', 'color', 'email', 'int', 'string'].sort());
    expect(groups.find((group) => group.name === 'Admin branding')!.settings.map((setting) => setting.key)).toEqual([DISPLAY_NAME, LOGIN_SUBTITLE, PRIMARY_COLOR, 'Branding:AccentColor']);
    expect(byKey.get(REQUIRE_TWO_FACTOR)).toMatchObject({ type: 'bool', isRestartRequired: false });
    expect(byKey.get(PRIMARY_COLOR)).toMatchObject({ type: 'color', required: true });
    expect(byKey.get(CACHE_SECONDS)).toMatchObject({ type: 'int', min: 10, max: 86400, isRestartRequired: false });
    expect(byKey.get(IDLE_MINUTES)).toMatchObject({ type: 'int', min: 5, max: 1440, isRestartRequired: true });
    expect(byKey.get(LOGIN_SUBTITLE)).toMatchObject({ type: 'string', maxLength: 100, required: false });
  });

  test('PSET-03 a live setting saved on the page keeps its value after a reload and writes one activity row with the admin as actor', { tag: '@write' }, async ({ page, shell, request }) => {
    test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to read the activity rows.');
    const api = new PlatformSettingsApi(AdminApi.asAdmin(request));
    const original = (await api.setting(RESET_PER_IP)).value;
    const probe = original === '21' ? '22' : '21';
    const since = lastChangeLogId();
    const settings = new PlatformSettingsPage(page);

    try {
      await settings.open();
      await expect(settings.input(RESET_PER_IP)).toHaveValue(original ?? '');
      await settings.input(RESET_PER_IP).fill(probe);
      await settings.save('Throttles');
      await shell.expectStatus('Settings saved.');

      await settings.open();
      await expect(settings.input(RESET_PER_IP)).toHaveValue(probe);
      await expect(settings.updatedHint(RESET_PER_IP)).toContainText(`Changed by ${adminAccount()!.email}`);
      expect(settingValue(RESET_PER_IP)).toBe(probe);

      expect(changeLogRows(RESET_PER_IP, since)).toEqual([{ summary: `Changed ${RESET_PER_IP} from ${original} to ${probe}`, createdBy: adminAccount()!.email }]);
      expect(changeLogRows('PasswordGrant:', since), 'unchanged settings in the group are skipped').toEqual([]);
    } finally {
      await api.restore({ [RESET_PER_IP]: original });
      expect(settingValue(RESET_PER_IP)).toBe(original);
    }
  });

  test('PSET-04 an out-of-range number and a bad colour show errors under their fields and nothing is saved', { tag: '@write' }, async ({ page, request }) => {
    test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to prove nothing was saved.');
    const api = new PlatformSettingsApi(AdminApi.asAdmin(request));
    const all = await api.all();
    const originals = { [CACHE_SECONDS]: all.get(CACHE_SECONDS)!.value, [PRIMARY_COLOR]: all.get(PRIMARY_COLOR)!.value };
    const since = lastChangeLogId();
    const settings = new PlatformSettingsPage(page);

    try {
      await settings.open();
      await settings.input(CACHE_SECONDS).fill('5');
      await settings.save('Identity cache');
      await expect(settings.fieldError(CACHE_SECONDS)).toHaveText('Use a number from 10 to 86400.');
      await expect(settings.groupError('Identity cache')).toContainText('Check the highlighted settings.');

      await settings.input(PRIMARY_COLOR).fill('blue');
      await settings.save('Admin branding');
      await expect(settings.fieldError(PRIMARY_COLOR)).toHaveText('Use a colour like #2c72ee.');
      await expect(settings.row(PRIMARY_COLOR).locator('[data-testid="setting-swatch"]')).toHaveCount(0);

      expect(settingValue(CACHE_SECONDS)).toBe(originals[CACHE_SECONDS]);
      expect(settingValue(PRIMARY_COLOR)).toBe(originals[PRIMARY_COLOR]);
      expect(lastChangeLogId(), 'no activity row').toBe(since);

      await settings.open();
      await expect(settings.input(CACHE_SECONDS)).toHaveValue(originals[CACHE_SECONDS] ?? '');
      await expect(settings.input(PRIMARY_COLOR)).toHaveValue(originals[PRIMARY_COLOR] ?? '');
      await expect(settings.fieldError(CACHE_SECONDS)).toHaveCount(0);
    } finally {
      if (settingValue(CACHE_SECONDS) !== originals[CACHE_SECONDS] || settingValue(PRIMARY_COLOR) !== originals[PRIMARY_COLOR]) {
        await api.restore(originals);
      }
    }
  });

  test('PSET-05 the API refuses bad values keyed by setting id: whole numbers, ranges, colours, emails and an absolute session shorter than the idle one', { tag: '@write' }, async ({ request }) => {
    const admin = AdminApi.asAdmin(request);
    const api = new PlatformSettingsApi(admin);
    const all = await api.all();
    const uuid = (key: string) => all.get(key)!.settingUuid;
    const before = Object.fromEntries([...all.values()].map((setting) => [setting.key, setting.value]));

    const cases: [string, string, string][] = [
      [CACHE_SECONDS, 'ten', 'Use a whole number.'],
      [CACHE_SECONDS, '86401', 'Use a number from 10 to 86400.'],
      [PRIMARY_COLOR, '#12345', 'Use a colour like #2c72ee.'],
      [SENDER_EMAIL, 'not-an-email', 'Use an email address like noreply@example.com.'],
      [REQUIRE_TWO_FACTOR, 'yes', 'Use true or false.'],
      [DISPLAY_NAME, '', 'A value is required.'],
      [ABSOLUTE_MINUTES, String(Number(all.get(IDLE_MINUTES)!.value) - 1 < 15 ? 15 : Number(all.get(IDLE_MINUTES)!.value) - 1), 'Must be at least the idle timeout.'],
    ];

    try {
      for (const [key, value, message] of cases) {
        const result = await api.save({ [key]: value });
        expect(result.status, `${key} = '${value}'`).toBe(400);
        expect(result.body.errors[uuid(key)], `${key} = '${value}'`).toEqual([message]);
      }

      const empty = await admin.put('/settings', { values: {} });
      expect(empty.status).toBe(400);
      const unknown = await admin.put('/settings', { values: { '00000000-0000-0000-0000-000000000000': '1' } });
      expect(unknown.status).toBe(400);

      const unchanged = await api.save({ [CACHE_SECONDS]: before[CACHE_SECONDS] });
      expect(unchanged.status).toBe(200);
      expect(unchanged.body).toMatchObject({ updatedCount: 0, restartRequiredKeys: [] });

      const after = await api.all();
      for (const [key, value] of Object.entries(before)) {
        expect(after.get(key)!.value, key).toBe(value);
      }
    } finally {
      const after = await api.all();
      const changed = Object.fromEntries(Object.entries(before).filter(([key, value]) => after.get(key)!.value !== value));
      if (Object.keys(changed).length) await api.restore(changed);
    }
  });

  test('PSET-06 saving a restart-required setting warns that it applies only after Identity restarts', { tag: '@write' }, async ({ page, shell, request }) => {
    const api = new PlatformSettingsApi(AdminApi.asAdmin(request));
    const original = (await api.setting(SWEEP_SECONDS)).value;
    const probe = original === '61' ? '62' : '61';
    const settings = new PlatformSettingsPage(page);

    try {
      await settings.open();
      await expect(settings.restartBadge(SWEEP_SECONDS)).toBeVisible();
      await settings.input(SWEEP_SECONDS).fill(probe);
      await settings.save('Sessions');
      await shell.expectStatus('Settings saved. 1 of them take effect only after Identity restarts.', 'warning');
      await expect(settings.input(SWEEP_SECONDS)).toHaveValue(probe);

      const response = await api.save({ [SWEEP_SECONDS]: original });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ updatedCount: 1, restartRequiredKeys: [SWEEP_SECONDS] });
    } finally {
      if ((await api.setting(SWEEP_SECONDS)).value !== original) await api.restore({ [SWEEP_SECONDS]: original });
    }
    expect((await api.setting(SWEEP_SECONDS)).value).toBe(original);
  });

  test.describe('without a token', () => {
    test.use(signedOut);

    test('PSET-07 the settings, branding image, admins and Identity feed endpoints refuse anonymous calls, and Identity publishes its password policy', async ({ request }) => {
      const anonymous = new AdminApi(request, null);
      for (const target of ['/settings', '/settings/branding/images', '/admins', '/identity/settings']) {
        expect((await anonymous.get(target)).status, target).toBe(401);
      }
      expect((await anonymous.put('/settings', { values: {} })).status).toBe(401);
      expect((await anonymous.post('/admins', { userUuid: '00000000-0000-0000-0000-000000000000' })).status).toBe(401);
      expect((await anonymous.upload('/settings/branding/images/logo-main', solidPng('e2e-qc823.png'))).status).toBe(401);
      expect((await anonymous.delete('/settings/branding/images/logo-main')).status).toBe(401);
      expect((await request.get(`${env.adminApiUrl}/api/public/branding/logo-main`, { ignoreHTTPSErrors: env.ignoreHttpsErrors })).status(), 'the public image route is anonymous: 404 only because nothing is set').toBe(404);

      const policy = await request.get(`${env.identityUrl}/api/account/password/policy`, { ignoreHTTPSErrors: env.ignoreHttpsErrors });
      expect(policy.status()).toBe(200);
      const body = await policy.json();
      expect(body).toMatchObject({ requiredLength: 10, requireUppercase: true, requireLowercase: true, requireDigit: true, requireNonAlphanumeric: true, requiredUniqueChars: 1 });
    });
  });

  test('PSET-08 a person\'s admin token cannot read the Identity settings feed', async ({ request }) => {
    expect((await AdminApi.asAdmin(request).get('/identity/settings')).status).toBe(403);
  });

  test('PSET-09 Identity brands the Admin sign-in from the platform settings', async ({ browser, request }) => {
    const displayName = (await new PlatformSettingsApi(AdminApi.asAdmin(request)).setting(DISPLAY_NAME)).value ?? DEFAULT_DISPLAY_NAME;
    const { context, page } = await adminLoginPage(browser);
    try {
      await expect(page).toHaveTitle(displayName);
      await expect(page.locator('body')).toContainText(`${new Date().getUTCFullYear()} ${displayName}`);
    } finally {
      await context.close();
    }
  });

  test('PSET-10 with two-step sign-in switched off a password-only platform admin gets in; switching it on refuses that token at once, and Identity shows a new login subtitle', { tag: '@write' }, async ({ page, shell, browser, request }) => {
    test.skip(!canSeedThrowawayUsers() || !canUseMasterDb(), "Needs Identity's and HOST_MASTER's local databases for a throwaway platform admin without two-step verification.");
    test.setTimeout((env.identityHostCacheSeconds + 180) * 1000);
    const api = new PlatformSettingsApi(AdminApi.asAdmin(request));
    const all = await api.all();
    const originals = {
      [REQUIRE_TWO_FACTOR]: all.get(REQUIRE_TWO_FACTOR)!.value,
      [LOGIN_SUBTITLE]: all.get(LOGIN_SUBTITLE)!.value,
      [CACHE_SECONDS]: all.get(CACHE_SECONDS)!.value,
    };
    expect(originals[REQUIRE_TWO_FACTOR], 'two-step sign-in is required before the test').toBe('true');
    const subtitle = `E2E QC-823 subtitle ${Date.now()}`;
    const settings = new PlatformSettingsPage(page);
    let user: ThrowawayUser | null = null;

    try {
      user = seedQc823User(PASSWORD_ONLY_EMAIL, 'QC-823 Password Only');
      makeQc823PlatformAdmin(user, PASSWORD_ONLY_NAME);

      expect((await api.save({ [CACHE_SECONDS]: IDENTITY_CACHE_FAST, [LOGIN_SUBTITLE]: subtitle })).status).toBe(200);

      await settings.open();
      await settings.toggle(REQUIRE_TWO_FACTOR).click();
      await settings.save('Admin sign-in');
      await expect(shell.confirmDialog.title).toHaveText('Stop requiring two-step sign-in for admins?');
      await shell.confirmDialog.accept();
      await shell.expectStatus('Settings saved.');
      expect(settingValue(REQUIRE_TWO_FACTOR)).toBe('false');

      await expect
        .poll(
          async () => {
            const login = await adminLoginPage(browser);
            try {
              return ((await new IdentityBrandingView(login.page).subtitle.textContent({ timeout: 2_000 }).catch(() => null)) ?? '').trim();
            } finally {
              await login.context.close();
            }
          },
          { message: "Identity re-reads the platform settings once its cache (HostMaster:CacheDurationSeconds) runs out", timeout: env.identityHostCacheSeconds * 1000, intervals: [10_000] },
        )
        .toBe(subtitle);

      const login = await adminLoginPage(browser);
      try {
        await new IdentityLoginPage(login.page).signIn(user);
        await expect(login.page.locator('#page-heading')).toHaveText(/^(Dashboard|Permission denied)$/, { timeout: 30_000 });
        await expect(login.page).not.toHaveURL(/EnableAuthenticator|LoginWith2fa/i);
        const token = await accessTokenFromPage(login.page);
        expect(token, 'the password-only admin got an access token').toBeTruthy();
        expect([decodeJwt(token!).claims.amr].flat()).not.toContain('mfa');

        const passwordOnly = new AdminApi(request, token);
        await expect
          .poll(async () => (await passwordOnly.get('/me')).body, { message: 'the Admin API counts the new admin (admin list cached for a minute)', timeout: 75_000, intervals: [5_000] })
          .toMatchObject({ isAdmin: true, needsTwoFactor: false });
        expect((await passwordOnly.get('/hosts')).status).toBe(200);

        await settings.open();
        await settings.toggle(REQUIRE_TWO_FACTOR).click();
        await settings.save('Admin sign-in');
        await expect(shell.confirmDialog.title).toHaveText('Require two-step sign-in for admins?');
        await shell.confirmDialog.accept();
        await shell.expectStatus('Settings saved.');
        expect(settingValue(REQUIRE_TWO_FACTOR)).toBe('true');

        expect((await passwordOnly.get('/me')).body, 'the saved switch evicts the cached value').toMatchObject({ needsTwoFactor: true });
        expect((await passwordOnly.get('/hosts')).status).toBe(403);
        expect((await AdminApi.asAdmin(request).get('/hosts')).status, 'a token with mfa still works').toBe(200);
      } finally {
        await login.context.close();
      }
    } finally {
      await api.restore(originals);
      removeQc823PlatformAdmins();
      removeQc823Users();
    }

    expect(settingValue(REQUIRE_TWO_FACTOR)).toBe(originals[REQUIRE_TWO_FACTOR]);
    expect(settingValue(LOGIN_SUBTITLE)).toBe(originals[LOGIN_SUBTITLE]);
    expect(settingValue(CACHE_SECONDS)).toBe(originals[CACHE_SECONDS]);
    await expect
      .poll(
        async () => {
          const login = await adminLoginPage(browser);
          try {
            return ((await new IdentityBrandingView(login.page).subtitle.textContent({ timeout: 2_000 }).catch(() => null)) ?? '').trim();
          } finally {
            await login.context.close();
          }
        },
        { message: 'Identity drops the test subtitle again within the short cache', timeout: 60_000, intervals: [5_000] },
      )
      .not.toBe(subtitle);
  });

  test("PSET-12 the main logo, icon and login background upload on the Settings page, show previews, are served anonymously with their type and safety headers, log one row each, and Remove clears them", { tag: '@write' }, async ({ page, shell, request }) => {
    test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) to read app.PlatformBrandingImages and the activity rows.');
    const branding = new PlatformBrandingApi(AdminApi.asAdmin(request), request);
    expect((await branding.images()).map(({ type, label, present }) => ({ type, label, present })), 'the run only uploads to empty slots').toEqual(
      PLATFORM_BRANDING_IMAGES.map(({ type, label }) => ({ type, label, present: false })),
    );
    const actor = adminAccount()!.email;
    const since = lastChangeLogId();
    const settings = new PlatformSettingsPage(page);
    await settings.open();
    const files: Record<PlatformImageType, UploadFile> = {
      'logo-main': solidPng('e2e-qc823-logo.png', 96, 32),
      'logo-icon': icoFromPng('e2e-qc823-icon.ico'),
      'login-background': await canvasJpeg(page, 'e2e-qc823-background.jpg'),
    };

    try {
      for (const image of PLATFORM_BRANDING_IMAGES) {
        await expect(settings.imageEmpty(image.type)).toHaveText('Not set');
        await expect(settings.imageRemove(image.type)).toHaveCount(0);
        await settings.uploadImage(image.type, files[image.type]);
        await shell.expectStatus(`${image.label} uploaded.`);
        await expect(settings.imagePreview(image.type)).toBeVisible();
        await expect(settings.imagePreview(image.type)).toHaveAttribute('src', publicRoutePattern(image.type));
        await expect.poll(() => settings.previewLoaded(image.type), { message: `the ${image.type} preview loads` }).toBe(true);
        await expect(settings.imageError(image.type)).toHaveCount(0);

        const served = await branding.publicImage(image.type);
        expect(served.status, image.type).toBe(200);
        expect(served.contentType, image.type).toBe(image.contentType);
        expect(served.headers['x-content-type-options'], image.type).toBe('nosniff');
        expect(served.headers['content-security-policy'], image.type).toBe(IMAGE_POLICY);
        expect(served.headers['cache-control'], image.type).toMatch(/max-age=300/);
        expect(served.bytes.equals(files[image.type].buffer), `${image.type} is served as uploaded`).toBe(true);
      }
      expect(storedImageCount()).toBe(3);
      expect(settingsActivity('Uploaded the Admin sign-in %', since)).toEqual(
        PLATFORM_BRANDING_IMAGES.map((image) => ({ summary: `Uploaded the Admin sign-in ${image.label.toLowerCase()}`, createdBy: actor })),
      );

      await settings.open();
      for (const image of PLATFORM_BRANDING_IMAGES) {
        await expect(settings.imagePreview(image.type)).toBeVisible();
        await expect(settings.imageTile(image.type)).toContainText(`Changed by ${actor}`);
        await expect(settings.imageRemove(image.type)).toBeEnabled();
      }
      await expect.poll(async () => (await Promise.all(PLATFORM_BRANDING_IMAGES.map((image) => settings.previewLoaded(image.type)))).every(Boolean)).toBe(true);
      fs.mkdirSync(path.dirname(reportScreenshotPath('settings-branding-images.png')), { recursive: true });
      await page.screenshot({ path: reportScreenshotPath('settings-branding-images.png'), fullPage: true });

      const removedSince = lastChangeLogId();
      for (const image of PLATFORM_BRANDING_IMAGES) {
        await settings.imageRemove(image.type).click();
        await expect(settings.confirmDialog.title).toHaveText(`Remove the ${image.label.toLowerCase()}?`);
        await settings.confirmDialog.accept();
        await shell.expectStatus(`${image.label} removed.`);
        await expect(settings.imageEmpty(image.type)).toHaveText('Not set');
        await expect(settings.imageRemove(image.type)).toHaveCount(0);
        expect((await branding.publicImage(image.type)).status, image.type).toBe(404);
      }
      expect(settingsActivity('Removed the Admin sign-in %', removedSince)).toEqual(
        PLATFORM_BRANDING_IMAGES.map((image) => ({ summary: `Removed the Admin sign-in ${image.label.toLowerCase()}`, createdBy: actor })),
      );
    } finally {
      await branding.removeAll();
    }
    expect(storedImageCount()).toBe(0);
  });

  test('PSET-13 the image upload refuses a text file, a .png or .jpg whose bytes do not match, an empty file and an unknown image, keyed by image type, and stores nothing', { tag: '@write' }, async ({ request }) => {
    const branding = new PlatformBrandingApi(AdminApi.asAdmin(request), request);
    expect((await branding.images()).some((image) => image.present), 'the run only works with empty slots').toBe(false);
    const since = canUseMasterDb() ? lastChangeLogId() : 0;
    const cases: [PlatformImageType, UploadFile, string][] = [
      ['logo-main', { name: 'e2e-qc823.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }, 'Use .png, .jpg, .jpeg, .svg, .ico.'],
      ['logo-main', { name: 'e2e-qc823.png', mimeType: 'image/png', buffer: Buffer.from('GIF89a not a PNG at all') }, 'That file is not a PNG image.'],
      ['login-background', { ...solidPng('e2e-qc823.jpg'), mimeType: 'image/jpeg' }, 'That file is not a JPG image.'],
      ['logo-icon', { name: 'e2e-qc823-empty.ico', mimeType: 'image/x-icon', buffer: Buffer.alloc(0) }, 'Choose an image.'],
    ];

    try {
      for (const [type, file, message] of cases) {
        const result = await branding.upload(type, file);
        expect(result.status, `${type} ${file.name}`).toBe(400);
        expect(result.body.errors, `${type} ${file.name}`).toEqual({ [type]: [message] });
      }

      const unknown = await branding.upload('logo-huge', solidPng('e2e-qc823.png'));
      expect(unknown.status).toBe(400);
      expect(unknown.body.detail).toBe('Unknown image.');
      expect((await branding.remove('logo-huge')).status).toBe(400);

      const nothingToRemove = await branding.remove('logo-main');
      expect(nothingToRemove.status).toBe(200);
      expect(nothingToRemove.body.message).toBe('There was no main logo to remove.');

      expect((await branding.images()).some((image) => image.present)).toBe(false);
      for (const type of [...PLATFORM_BRANDING_IMAGES.map((image) => image.type), 'logo-huge']) {
        expect((await branding.publicImage(type)).status, type).toBe(404);
      }
      if (canUseMasterDb()) {
        expect(storedImageCount()).toBe(0);
        expect(lastChangeLogId(), 'no activity row').toBe(since);
      }
    } finally {
      await branding.removeAll();
    }
  });

  test("PSET-14 Identity's Admin sign-in page shows an uploaded main logo and login background from the public routes and drops them once removed", { tag: '@write' }, async ({ page, browser, request }) => {
    test.setTimeout((env.identityHostCacheSeconds + 150) * 1000);
    const api = new PlatformSettingsApi(AdminApi.asAdmin(request));
    const branding = new PlatformBrandingApi(AdminApi.asAdmin(request), request);
    expect((await branding.images()).some((image) => image.present), 'the run only uploads to empty slots').toBe(false);
    const originalCache = (await api.setting(CACHE_SECONDS)).value;

    try {
      expect((await api.save({ [CACHE_SECONDS]: IDENTITY_CACHE_FAST })).status).toBe(200);
      expect((await branding.upload('logo-main', solidPng('e2e-qc823-logo.png', 96, 32))).status).toBe(200);
      expect((await branding.upload('login-background', await canvasJpeg(page, 'e2e-qc823-background.jpg'))).status).toBe(200);

      await expect
        .poll(() => adminSignInBranding(browser), {
          message: 'Identity re-reads the platform settings once its cache (HostMaster:CacheDurationSeconds) runs out',
          timeout: env.identityHostCacheSeconds * 1000,
          intervals: [10_000],
        })
        .toEqual({
          logo: expect.stringMatching(publicRoutePattern('logo-main')),
          background: expect.stringMatching(publicRoutePattern('login-background')),
          favicon: '/favicon.ico',
        });

      const login = await adminLoginPage(browser);
      try {
        const view = new IdentityBrandingView(login.page);
        await expect.poll(() => view.logoLoaded(), { message: 'the main logo loads through the public route', timeout: 30_000 }).toBe(true);
        await expect(view.background).toHaveClass(/sign-in-area/);
        const background = await request.get((await view.backgroundImageUrl())!, { ignoreHTTPSErrors: env.ignoreHttpsErrors });
        expect(background.status()).toBe(200);
        expect(background.headers()['content-type']).toBe('image/jpeg');
      } finally {
        await login.context.close();
      }
    } finally {
      await branding.removeAll();
      await api.restore({ [CACHE_SECONDS]: originalCache });
    }

    expect((await api.setting(CACHE_SECONDS)).value).toBe(originalCache);
    if (canUseMasterDb()) {
      expect(settingValue(CACHE_SECONDS)).toBe(originalCache);
      expect(storedImageCount()).toBe(0);
    }
    await expect
      .poll(() => adminSignInBranding(browser), { message: 'Identity drops the removed images again within the short cache', timeout: 60_000, intervals: [5_000] })
      .toEqual({ logo: null, background: null, favicon: '/favicon.ico' });
  });
});
