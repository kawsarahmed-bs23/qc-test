import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../fixtures/test';
import { env } from '../../config/environment';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue } from '../../fixtures/localDb';
import {
  HostLogoApi,
  JPEG_SIGNATURE,
  LogoSettingsPage,
  PNG_SIGNATURE,
  QC803_ADMIN_STATE,
  ThrowawayHostAdmin,
  TicketUploadScreen,
  decodeImage,
  pngColourType,
  sha256,
  type UploadFile,
} from '../../pages/LogoUploadPages';
import type { Browser } from '@playwright/test';

const FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'qc803');
const LOGO_COLUMNS = ['LogoMainPath', 'LogoMenuPath', 'LogoSystemPath', 'LogoIconPath', 'LogoLargePath', 'LoginBackgroundPath'];

function fixture(name: string, mimeType: string): UploadFile {
  return { name, mimeType, buffer: fs.readFileSync(path.join(FIXTURES, name)) };
}

function logoPaths(): string | null {
  return querySingleValue(
    `SELECT CONCAT_WS('|', ${LOGO_COLUMNS.map((c) => `ISNULL(${c}, N'<null>')`).join(', ')}) FROM app.HostSettings WHERE HostSettingID = 1`,
  );
}

function systemLogoPath(): string | null {
  return querySingleValue('SELECT LogoSystemPath FROM app.HostSettings WHERE HostSettingID = 1');
}

async function withLogoApi<T>(browser: Browser, work: (api: HostLogoApi) => Promise<T>): Promise<T> {
  const context = await browser.newContext({ baseURL: env.appUrl ?? undefined, ignoreHTTPSErrors: env.ignoreHttpsErrors, storageState: QC803_ADMIN_STATE });
  try {
    return await work(await HostLogoApi.signedIn(await context.newPage()));
  } finally {
    await context.close();
  }
}

interface OriginalLogo {
  path: string | null;
  allPaths: string | null;
  bytes: Buffer | null;
  contentType: string;
  sha: string | null;
}

test.describe('Company logos keep their format and fit the header (QC-803)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to read app.HostSettings logo paths.');
  test.skip(!env.appApiUrl, 'APP_API_URL (the host API) is not set for this environment.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.describe.configure({ mode: 'serial' });
  test.use({ storageState: QC803_ADMIN_STATE });

  let original: OriginalLogo | null = null;

  test.beforeAll(async ({ browser }, testInfo) => {
    await ThrowawayHostAdmin.signIn(browser);
    const allPaths = logoPaths();
    const systemPath = systemLogoPath();
    original = await withLogoApi(browser, async (api) => {
      const url = await api.logoUrl('logo-system');
      if (systemPath && !url) throw new Error(`LogoSystemPath is ${systemPath} but the API sends no logoSystemUrl.`);
      if (!url) return { path: null, allPaths, bytes: null, contentType: '', sha: null };
      const served = await api.download(url);
      return { path: systemPath, allPaths, bytes: served.bytes, contentType: served.contentType, sha: sha256(served.bytes) };
    }).catch((error) => {
      testInfo.annotations.push({ type: 'backup-failed', description: String(error) });
      return null;
    });
    if (original?.bytes) {
      fs.writeFileSync(testInfo.outputPath(path.basename(original.path!)), original.bytes);
    }
    testInfo.annotations.push({
      type: 'original-system-logo',
      description: `path=${original?.path ?? 'null'} sha256=${original?.sha ?? 'none'} contentType=${original?.contentType ?? ''} paths=${allPaths}`,
    });
  });

  test.beforeEach(() => {
    test.skip(!original, 'The original System Logo could not be backed up, so no upload is made.');
  });

  test.afterAll(async ({ browser }, testInfo) => {
    try {
      if (original) await restoreSystemLogo(browser, testInfo);
    } finally {
      ThrowawayHostAdmin.remove();
    }
  });

  async function restoreSystemLogo(browser: Browser, testInfo: import('@playwright/test').TestInfo): Promise<void> {
    if (!original) return;
    const restored = await withLogoApi(browser, async (api) => {
      if (original!.bytes) {
        const status = await api.upload('logo-system', {
          name: path.basename(original!.path!),
          mimeType: original!.contentType || 'application/octet-stream',
          buffer: original!.bytes,
        });
        expect(status, 'restore POST logo-system').toBe(200);
      } else if (systemLogoPath() !== null) {
        expect(await api.remove('logo-system'), 'restore DELETE logo-system').toBe(200);
      }
      const url = await api.logoUrl('logo-system');
      const served = url ? await api.download(url) : null;
      return { sha: served ? sha256(served.bytes) : null, contentType: served?.contentType ?? '' };
    });
    const pathAfter = systemLogoPath();
    const allAfter = logoPaths();
    testInfo.annotations.push({
      type: 'restored-system-logo',
      description: `path=${pathAfter ?? 'null'} sha256=${restored.sha ?? 'none'} contentType=${restored.contentType} paths=${allAfter}`,
    });
    expect(pathAfter, 'LogoSystemPath after restore').toBe(original.path);
    expect(allAfter, 'all Logo*Path columns after restore').toBe(original.allPaths);
    expect(restored.sha, 'served System Logo SHA-256 after restore').toBe(original.sha);
    expect(restored.contentType, 'served System Logo content type after restore').toBe(original.contentType);
  }

  test('LOGO-01 a transparent PNG rotated in the cropper is sent, stored and shown as a PNG with its transparency', async ({ page }) => {
    const source = fixture('logo-transparent.png', 'image/png');
    const settings = new LogoSettingsPage(page);
    await settings.open();
    const before = await settings.header.logoSrc();

    await settings.chooseFile('logo-system', source);
    expect(await settings.cropper.outputFormat()).toBe('png');
    await settings.cropper.rotate('clockwise');
    const { status, sent } = await settings.saveCropped('logo-system');

    expect(status).toBe(200);
    expect(sent.fileName).toMatch(/\.png$/);
    expect(sent.contentType).toBe('image/png');
    expect(sent.bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'POST body starts with the PNG signature').toBe(true);
    expect(sent.bytes.equals(source.buffer), 'the cropper re-encoded the image rather than sending the source file').toBe(false);
    expect(pngColourType(sent.bytes), 'IHDR colour type 6 (RGBA)').toBe(6);
    const sentImage = await decodeImage(page, sent.bytes);
    expect(sentImage.topLeft[3], 'corner alpha of the sent image').toBe(0);

    const src = await settings.header.waitForLogoChange(before);
    expect(new URL(src).pathname).toMatch(/\/logo-system\.png$/);
    expect(systemLogoPath()).toMatch(/\/logo-system\.png$/);
    const api = await HostLogoApi.signedIn(page);
    const served = await api.download(src);
    expect(served.contentType).toBe('image/png');
    expect(served.bytes.subarray(0, 8).equals(PNG_SIGNATURE), 'served header image starts with the PNG signature').toBe(true);
    expect(served.bytes.equals(sent.bytes), 'the header serves the bytes that were uploaded').toBe(true);
    expect(pngColourType(served.bytes)).toBe(6);
    expect((await decodeImage(page, served.bytes)).topLeft[3], 'corner alpha of the served image').toBe(0);

    await settings.open();
    const corner = await settings.header.logoCornerPixel();
    expect(Math.max(corner[0], corner[1], corner[2]), `header logo corner pixel ${corner.join(',')} is not black`).toBeGreaterThan(64);
  });

  test('LOGO-02 a JPEG logo saved through the cropper is sent as JPEG', async ({ page }) => {
    const source = fixture('logo-solid.jpg', 'image/jpeg');
    const settings = new LogoSettingsPage(page);
    await settings.open();

    await settings.chooseFile('logo-system', source);
    expect(await settings.cropper.outputFormat()).toBe('jpeg');
    const { status, sent } = await settings.saveCropped('logo-system');

    expect(status).toBe(200);
    expect(sent.fileName).toMatch(/\.jpe?g$/);
    expect(sent.contentType).toBe('image/jpeg');
    expect(sent.bytes.subarray(0, 3).equals(JPEG_SIGNATURE), 'POST body starts with FF D8 FF').toBe(true);
    await expect.poll(() => systemLogoPath()).toMatch(/\/logo-system\.jpe?g$/);
  });

  test('LOGO-03 the header logo is at most 40px high and 160px wide with a 12px gap before the company name, also at 375px', async ({ page }) => {
    const settings = new LogoSettingsPage(page);
    const header = settings.header;
    await settings.open();

    let before = await header.logoSrc();
    await settings.chooseFile('logo-system', fixture('logo-transparent.png', 'image/png'));
    expect((await settings.saveCropped('logo-system')).status).toBe(200);
    await header.waitForLogoChange(before);
    const square = await header.box(header.logo);
    const nameBox = await header.box(header.companyName);
    expect(square.height).toBeLessThanOrEqual(40.5);
    expect(square.height).toBeGreaterThan(30);
    expect(nameBox.x - (square.x + square.width), 'gap between logo and company name').toBeGreaterThanOrEqual(11);
    expect(nameBox.x - (square.x + square.width), 'gap between logo and company name').toBeLessThanOrEqual(13);

    before = await header.logoSrc();
    await settings.chooseFile('logo-system', fixture('logo-wide.png', 'image/png'));
    expect((await settings.saveCropped('logo-system')).status).toBe(200);
    await header.waitForLogoChange(before);
    const wide = await header.box(header.logo);
    const wideName = await header.box(header.companyName);
    expect(wide.width).toBeLessThanOrEqual(160.5);
    expect(wide.width).toBeGreaterThan(100);
    expect(wide.height).toBeLessThanOrEqual(40.5);
    expect(wideName.x - (wide.x + wide.width), 'gap between wide logo and company name').toBeGreaterThanOrEqual(11);
    expect(wideName.x - (wide.x + wide.width), 'gap between wide logo and company name').toBeLessThanOrEqual(13);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(header.logo).toBeVisible();
    await expect.poll(() => header.logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    await expect(header.companyName).toBeVisible();
    const mobileLogo = await header.box(header.logo);
    const mobileName = await header.box(header.companyName);
    expect(mobileLogo.width).toBeLessThanOrEqual(160.5);
    expect(mobileLogo.height).toBeLessThanOrEqual(40.5);
    expect(mobileName.x, 'company name starts after the logo at 375px').toBeGreaterThanOrEqual(mobileLogo.x + mobileLogo.width + 11);
    expect(await header.companyNameIsOnTop(), 'nothing covers the company name at 375px').toBe(true);
    expect(mobileName.x + mobileName.width, 'company name stays inside the 375px viewport').toBeLessThanOrEqual(375);
  });

  test('LOGO-04 a ticket photo edited in the ticket cropper is still saved as JPEG, even from a PNG source', async ({ page }) => {
    const sentToApi: string[] = [];
    await page.route(/\/api\/.*ticket/i, async (route) => {
      if (route.request().method() === 'GET') return route.continue();
      sentToApi.push(`${route.request().method()} ${route.request().url()}`);
      return route.abort();
    });
    const tickets = new TicketUploadScreen(page);
    await tickets.open();

    await tickets.fileInput.setInputFiles({
      name: 'e2e-qc803-ticket.jpg',
      mimeType: 'image/png',
      buffer: fs.readFileSync(path.join(FIXTURES, 'logo-transparent.png')),
    });
    await expect(tickets.firstEdit).toBeEnabled({ timeout: 15_000 });
    await tickets.firstEdit.click();
    await tickets.cropper.expectOpen();
    expect(await tickets.cropper.outputFormat()).toBe('jpeg');
    await tickets.cropper.rotate('clockwise');
    await tickets.cropper.save.click();
    await expect(tickets.cropper.popup).toBeHidden();

    const edited = await tickets.selectedFile(0);
    expect(edited.contentType).toBe('image/jpeg');
    expect(edited.bytes.subarray(0, 3).equals(JPEG_SIGNATURE), 'edited ticket photo starts with FF D8 FF').toBe(true);
    expect(sentToApi, 'no ticket write reached the API').toEqual([]);
  });
});
