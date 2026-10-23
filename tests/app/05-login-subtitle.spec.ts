import { test, expect } from '../../fixtures/test';
import { APP_STATE, env } from '../../config/environment';
import { canSeedLocalDb, querySingleValue, runSeedScript } from '../../fixtures/localDb';
import { CompanySettingsPage, HostSettingsApi, HostSignInScreen, type HostSettingsModel } from '../../pages/LoginSubtitlePages';
import type { Browser } from '@playwright/test';

const HOST_SETTING_ID = 1;
const LEGACY_SUBTITLE = 'Dispatch Management System';
const KEPT_SUBTITLE = 'E2E-QC721 kept after save';
const NO_SESSION =
  'No signed-in host-app admin session (app-setup): GET api/setting/host-setting needs AdministerOrganisations. The local app admin now stops at Identity two-step verification.';

function storedSubtitle(): string | null {
  const raw = querySingleValue(
    `SELECT CASE WHEN LoginSubtitle IS NULL THEN NULL ELSE N'[' + LoginSubtitle + N']' END FROM app.HostSettings WHERE HostSettingID = ${HOST_SETTING_ID}`,
  );
  return raw === null ? null : raw.slice(1, -1);
}

function hostSettingsFingerprint(): string | null {
  return querySingleValue(
    `DECLARE @c nvarchar(max) = (SELECT STRING_AGG(QUOTENAME(name), ',') FROM sys.columns WHERE object_id = OBJECT_ID('app.HostSettings') AND name <> 'Updated');
     DECLARE @s nvarchar(max) = N'SELECT CONVERT(varchar(64), HASHBYTES(''SHA2_256'', (SELECT ' + @c + N' FROM app.HostSettings WHERE HostSettingID = ${HOST_SETTING_ID} FOR JSON PATH, INCLUDE_NULL_VALUES)), 2)';
     EXEC (@s);`,
  );
}

async function withHostApi<T>(browser: Browser, work: (api: HostSettingsApi) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: env.appUrl ?? undefined, ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: APP_STATE });
  try {
    return await work(await HostSettingsApi.signedIn(await context.newPage()));
  } finally {
    await context.close();
  }
}

async function expectSignInSubtitle(browser: Browser, expected: string | null): Promise<void> {
  const screen = await HostSignInScreen.open(browser);
  try {
    if (expected === null) {
      await expect(screen.subtitle).toHaveCount(0);
    } else {
      await expect(screen.subtitle).toHaveCount(1);
      await expect(screen.subtitle).toHaveText(expected, { useInnerText: true });
    }
  } finally {
    await screen.close();
  }
}

test.describe('Login page subtitle when none is set (QC-721)', () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to read app.HostSettings.');
  test.skip(!env.appApiUrl, 'APP_API_URL (the host API) is not set for this environment.');

  test('SUB-01 with no subtitle stored, the public settings send null and the sign-in page has no subtitle element', async ({ browser }) => {
    test.skip(storedSubtitle() !== null, 'The local host has a login subtitle set; SUB-01 checks the unset state.');

    const screen = await HostSignInScreen.open(browser);
    try {
      expect(await screen.publicLoginSubtitle()).toBeNull();
      await expect(screen.subtitle).toHaveCount(0);
      await expect(screen.page.getByText(LEGACY_SUBTITLE)).toHaveCount(0);
    } finally {
      await screen.close();
    }
  });
});

test.describe('Login page subtitle (QC-721)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to read app.HostSettings.');
  test.skip(!env.appApiUrl, 'APP_API_URL (the host API) is not set for this environment.');
  test.describe.configure({ mode: 'serial' });

  let originalSubtitle: string | null;
  let originalFingerprint: string | null;
  let originalModel: HostSettingsModel | null = null;

  test.beforeAll(async ({ browser }) => {
    originalSubtitle = storedSubtitle();
    originalFingerprint = hostSettingsFingerprint();
    originalModel = await withHostApi(browser, (api) => api.get()).catch(() => null);
    if (originalModel) {
      expect(originalModel.loginSubtitle ?? null, 'the API model reads the stored subtitle').toBe(originalSubtitle);
    }
  });

  test.beforeEach(() => {
    test.skip(!originalModel, NO_SESSION);
  });

  test.afterAll(async ({ browser }) => {
    if (originalModel && hostSettingsFingerprint() !== originalFingerprint) {
      await withHostApi(browser, (api) => api.post(originalModel!));
    }
    if (originalSubtitle === null && storedSubtitle() !== null) {
      runSeedScript('login-subtitle.remove.sql');
    }
  });

  test('SUB-02 a subtitle saved through host settings is sent by the public settings and shown under Sign In', async ({ page, browser }) => {
    const api = await HostSettingsApi.signedIn(page);
    const saved = await api.setLoginSubtitle(LEGACY_SUBTITLE);

    expect(saved.status).toBe(200);
    expect(saved.data?.loginSubtitle).toBe(LEGACY_SUBTITLE);
    expect(storedSubtitle()).toBe(LEGACY_SUBTITLE);
    expect((await api.get()).loginSubtitle).toBe(LEGACY_SUBTITLE);
    expect(await api.publicLoginSubtitle()).toBe(LEGACY_SUBTITLE);
    await expectSignInSubtitle(browser, LEGACY_SUBTITLE);
  });

  test('SUB-03 a whitespace-only subtitle is stored as NULL and the sign-in page shows none', async ({ page, browser }) => {
    const api = await HostSettingsApi.signedIn(page);
    if (storedSubtitle() === null) {
      expect((await api.setLoginSubtitle(LEGACY_SUBTITLE)).status).toBe(200);
    }

    const saved = await api.setLoginSubtitle('   ');

    expect(saved.status).toBe(200);
    expect(storedSubtitle()).toBeNull();
    expect(await api.publicLoginSubtitle()).toBeNull();
    await expectSignInSubtitle(browser, null);
  });

  test('SUB-04 a subtitle with surrounding spaces is stored and shown trimmed', async ({ page, browser }) => {
    const api = await HostSettingsApi.signedIn(page);
    const saved = await api.setLoginSubtitle('  Padded  ');

    expect(saved.status).toBe(200);
    expect(storedSubtitle()).toBe('Padded');
    expect(await api.publicLoginSubtitle()).toBe('Padded');
    await expectSignInSubtitle(browser, 'Padded');
  });

  test('SUB-05 a 101-character subtitle is rejected with a LoginSubtitle validation error and nothing is stored', async ({ page }) => {
    const api = await HostSettingsApi.signedIn(page);
    const before = storedSubtitle();
    const publicBefore = await api.publicLoginSubtitle();

    const rejected = await api.setLoginSubtitle('S'.repeat(101));

    expect(rejected.status).toBe(400);
    const field = Object.keys(rejected.validationErrors).find((key) => key.toLowerCase() === 'loginsubtitle');
    expect(field, `validation errors: ${JSON.stringify(rejected.validationErrors)}`).toBeDefined();
    expect(rejected.validationErrors[field!].join(' ')).toContain('Login page subtitle must be at most 100 characters.');
    expect(storedSubtitle()).toBe(before);
    expect(await api.publicLoginSubtitle()).toBe(publicBefore);
  });

  test('SUB-06 a subtitle of exactly 100 characters is accepted and stored whole', async ({ page }) => {
    const api = await HostSettingsApi.signedIn(page);
    const longest = 'E2E-QC721 '.repeat(10).slice(0, 99) + 'X';

    const saved = await api.setLoginSubtitle(longest);

    expect(saved.status).toBe(200);
    expect(storedSubtitle()).toBe(longest);
    expect(await api.publicLoginSubtitle()).toBe(longest);
  });

  test('SUB-07 saving Company Settings without changes keeps the stored subtitle', async ({ page, browser }) => {
    const api = await HostSettingsApi.signedIn(page);
    expect((await api.setLoginSubtitle(KEPT_SUBTITLE)).status).toBe(200);
    expect(storedSubtitle()).toBe(KEPT_SUBTITLE);

    try {
      const companySettings = new CompanySettingsPage(page);
      await companySettings.open();
      const form = await companySettings.formState();
      expect(form.value.loginSubtitle, 'the Company Settings form holds the subtitle it will post back').toBe(KEPT_SUBTITLE);
      if (!form.valid) {
        test.info().annotations.push({
          type: 'save-skipped',
          description: `Company Settings form is invalid before any change (${form.invalid.join(', ')}); the save round-trip is not exercised here.`,
        });
        return;
      }
      const { status, sent } = await companySettings.saveAndWait();

      expect(sent.loginSubtitle, 'the Company Settings form sends the subtitle back').toBe(KEPT_SUBTITLE);
      expect(status).toBe(200);
      expect(storedSubtitle()).toBe(KEPT_SUBTITLE);
      expect(await api.publicLoginSubtitle()).toBe(KEPT_SUBTITLE);
      await expectSignInSubtitle(browser, KEPT_SUBTITLE);
    } finally {
      expect((await api.post(originalModel!)).status).toBe(200);
    }
  });

  test('SUB-08 restoring the original host settings puts the subtitle back and leaves every other column as it was', async ({ page, browser }) => {
    const api = await HostSettingsApi.signedIn(page);
    expect((await api.post(originalModel!)).status).toBe(200);

    expect(storedSubtitle()).toBe(originalSubtitle);
    expect(hostSettingsFingerprint(), 'app.HostSettings row (all columns but Updated)').toBe(originalFingerprint);
    expect(await api.publicLoginSubtitle()).toBe(originalSubtitle);
    await expectSignInSubtitle(browser, originalSubtitle);
  });
});
