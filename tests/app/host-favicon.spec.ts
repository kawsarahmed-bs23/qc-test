import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { uiFaviconBytes } from '@pages/host-favicon.page';

test.describe('The host app carries the Quarry Connect icon (QC-996)', { tag: ['@regression', '@smoke'] }, () => {
  test.use(signedOut);
  test.skip(!env.appUrl, 'APP_URL is not set for this environment.');

  test('FAVI-01 /favicon.ico is served with the bytes of quarryconnect-ui/public/favicon.ico', async ({ hostFaviconPage }) => {
    const served = await hostFaviconPage.rootFaviconBytes();

    expect(served.equals(uiFaviconBytes())).toBe(true);
  });

  test('FAVI-02 the icon the app declares before any host branding loads, which a wrong address keeps, is the Quarry Connect icon', async ({
    hostFaviconPage,
  }) => {
    const icon = await hostFaviconPage.iconDeclaredByTheApp();

    expect(icon.equals(uiFaviconBytes())).toBe(true);
  });
});
