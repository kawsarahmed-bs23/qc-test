import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, queryMasterDb, runIdentitySeedScript } from '@utils/localDb';
import { newInvitePassword, publicInviteKeyOf, signInviteLink } from '@utils/inviteLinks';
import { identityAcceptsLink, masterHasInviteKeys, masterInviteKeys, registerTestInviteKey, removeTestInviteKeys } from '@api/user-invites.api';
import { hostSiteUrl } from '@pages/host-site-address.page';

const RUN = Date.now();
const EMAIL_LIKE = 'qc914-e2e-site-%@example.test';
const INVITED_EMAIL = `qc914-e2e-site-${RUN}@example.test`;

function hostUuidOf(clientId: string): string | null {
  return queryMasterDb(`SELECT CONVERT(varchar(36), HostUUID) FROM app.Hosts WHERE ClientID = N'${clientId.replace(/'/g, "''")}'`);
}

test.describe("Identity pages use the host's own site address (QC-992 / QC-993)", { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);
  test.skip(!env.hostClient || !env.appUrl, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI) and APP_URL.');

  test('SITE-01 the sign-in page for the host client says it continues to the host site, not to its first return address', async ({ hostSiteAddressPage }) => {
    await hostSiteAddressPage.openLoginForHostClient();

    await hostSiteAddressPage.expectContinueTo(new URL(hostSiteUrl()).host);
  });

  test('SITE-02 the Terms and Privacy links in the sign-in footer open www.quarryconnect.com/terms and /privacy in a new tab, not the host site (QC-1006)', async ({
    hostSiteAddressPage,
  }) => {
    await hostSiteAddressPage.openLoginForHostClient();

    await hostSiteAddressPage.expectFooterLinks();
  });

  test.describe('Setup Complete after an invite', () => {
    test.skip(!env.inviteHostPrivateJwk, 'Needs the test invite signing key (INVITE_TEST_HOST_PRIVATE_JWK).');
    test.skip(!canUseIdentityDb() || !canUseMasterDb(), "Needs Identity's and HOST_MASTER's local databases.");

    let issuer = '';
    let registeredKey = false;

    test.beforeAll(async ({ playwright }) => {
      test.setTimeout(env.identityHostCacheSeconds * 1000 + 60_000);
      issuer = hostUuidOf(env.hostClient!.clientId) ?? '';
      expect(issuer, `host ${env.hostClient!.clientId} in HOST_MASTER`).toMatch(/^[0-9A-F-]{36}$/i);
      runIdentitySeedScript('identity-qc914.remove.sql', { EmailLike: EMAIL_LIKE });
      if (!masterHasInviteKeys()) return;
      const key = publicInviteKeyOf(env.inviteHostPrivateJwk!);
      if (!masterInviteKeys(issuer).some((row) => row.active && row.kid === key.kid && row.x === key.x)) {
        registerTestInviteKey(env.hostClient!.clientId, key);
        registeredKey = true;
      }
      const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        await expect
          .poll(
            () =>
              identityAcceptsLink(
                request,
                signInviteLink({
                  privateJwk: env.inviteHostPrivateJwk!,
                  issuer,
                  returnUrl: env.hostClient!.redirectUri,
                  email: `qc914-e2e-site-probe-${RUN}@example.test`,
                }).token,
              ),
            { message: 'Identity takes links signed with the test key', timeout: env.identityHostCacheSeconds * 1000, intervals: [5_000, 10_000, 15_000] },
          )
          .toBe(true);
      } finally {
        await request.dispose();
      }
    });

    test.afterAll(() => {
      if (registeredKey) removeTestInviteKeys();
      runIdentitySeedScript('identity-qc914.remove.sql', { EmailLike: EMAIL_LIKE });
      expect(Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE Email LIKE N'${EMAIL_LIKE}'`)), 'no invite user is left').toBe(0);
    });

    test("SITE-03 the invite's Setup Complete page links the host site and not the first return address", async ({
      identityInvitePage,
      hostSiteAddressPage,
    }) => {
      const returnUrl = env.hostClient!.redirectUri;
      const invite = signInviteLink({
        privateJwk: env.inviteHostPrivateJwk!,
        issuer,
        returnUrl,
        email: INVITED_EMAIL,
        givenName: 'Site',
        familyName: 'Tester',
      });
      await identityInvitePage.catchReturn(returnUrl);
      await identityInvitePage.open(invite.token);
      await identityInvitePage.saveSettings({ password: newInvitePassword(), acceptTerms: true });
      const result = await identityInvitePage.resultAt(returnUrl);

      await identityInvitePage.openComplete(result);

      await hostSiteAddressPage.expectCompleteLoginLink(hostSiteUrl());
      await hostSiteAddressPage.expectFooterLinks();
    });
  });
});
