import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1366, height: 900 };

test.describe('Identity flag language switch and legal links (QC-1006)', { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);

  for (const [device, viewport] of [
    ['a phone', PHONE],
    ['a desktop', DESKTOP],
  ] as const) {
    test(`LANG-01 on ${device} the sign-in page shows a US then a Mexico flag tile named English and Español inside the card, top right above the logo, and nothing fixed to the window`, async ({
      page,
      hostSiteAddressPage,
    }) => {
      await page.setViewportSize(viewport);
      await hostSiteAddressPage.openPlatformLogin();
      await hostSiteAddressPage.expectFlagSwitchInCard();
      await hostSiteAddressPage.expectLanguage('en');
      await hostSiteAddressPage.attachScreenshot(`identity-sign-in-${viewport.width}-en`);
    });
  }

  test('LANG-02 pressing the Mexico flag shows the page in Spanish with that flag selected, the next Identity page stays Spanish, and the US flag returns to English', async ({
    page,
    hostSiteAddressPage,
  }) => {
    await page.setViewportSize(PHONE);
    await hostSiteAddressPage.openPlatformLogin();
    await hostSiteAddressPage.spanish.click();
    await expect(page).toHaveURL(/\/Account\/Login/);
    await hostSiteAddressPage.expectLanguage('es');
    await hostSiteAddressPage.attachScreenshot('identity-sign-in-390-es');

    await hostSiteAddressPage.openForgotPassword();
    await hostSiteAddressPage.expectFlagSwitchInCard();
    await hostSiteAddressPage.expectLanguage('es');
    await hostSiteAddressPage.attachScreenshot('identity-forgot-password-390-es');

    await hostSiteAddressPage.english.click();
    await expect(page).toHaveURL(/\/Account\/ForgotPassword/);
    await hostSiteAddressPage.expectLanguage('en');
    await hostSiteAddressPage.openPlatformLogin();
    await hostSiteAddressPage.expectLanguage('en');
  });

  test('LANG-03 in English and Spanish the Terms and Privacy links open www.quarryconnect.com/terms and /privacy in a new tab, on the platform sign-in and on the host client sign-in', async ({
    hostSiteAddressPage,
  }) => {
    const opens: (() => Promise<void>)[] = [() => hostSiteAddressPage.openPlatformLogin()];
    if (env.hostClient) opens.push(() => hostSiteAddressPage.openLoginForHostClient());

    for (const open of opens) {
      await open();
      await hostSiteAddressPage.english.click();
      await hostSiteAddressPage.expectLanguage('en');
      await hostSiteAddressPage.expectFooterLinks();
      await hostSiteAddressPage.spanish.click();
      await hostSiteAddressPage.expectLanguage('es');
      await hostSiteAddressPage.expectFooterLinks();
      await hostSiteAddressPage.english.click();
    }
  });
});
