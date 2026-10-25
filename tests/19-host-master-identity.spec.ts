import { randomUUID } from 'crypto';
import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, signedOut } from '../fixtures/test';
import {
  canSeedLocalDb,
  canUseDriversDb,
  canUseMasterDb,
  queryMasterDb,
  runDriversSeedScript,
  runMasterSeedScript,
  runSeedScript,
} from '../fixtures/localDb';
import {
  canSeedThrowawayUsers,
  makePlatformAdmin,
  removeIdentityUsers,
  removePlatformAdmins,
  seedIdentityUser,
  type ThrowawayUser,
} from '../fixtures/throwawayUsers';
import { AdminApi, accessTokenFromPage, adminTokenFromState, canUseAdminApi } from '../pages/AdminApi';
import { adminUrl, openAdmin } from '../pages/AdminShell';
import { HostFeaturesPage, HostSignInSettingsPage, type HostAllowedUrls, type HostBranding } from '../pages/HostManagementPages';
import { DashboardPage, HostNav } from '../pages/HostPages';
import { authorizeUrl, HostSignInFlow, identityLanding } from '../pages/HostSignInFlow';
import { IdentityLoginPage, IdentityTwoStepPage } from '../pages/IdentityLoginPage';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi, type TokenResponse } from '../pages/PasswordGrantApi';
import { env, type OidcClient } from '../config/environment';

const THROWAWAY_HOST = {
  key: 'e2e-qc775',
  name: 'E2E QC-775 Sign-in',
  client: { clientId: 'e2e-qc775.web', redirectUri: 'http://localhost:4275/' } as OidcClient,
  branding: { displayName: 'E2E QC-775 Sign-in', primaryColor: '#7a1f2b' },
};
const EXTRA_RETURN_URL = 'http://localhost:4276/';
const HOST_CLAIMS = ['role', 'OrganisationId', 'host_uuid', 'hosts'];
const USERS = 'e2e.qc775.t.%';
const PLATFORM_ADMINS = 'E2E QC-775 Test%';

function throwawayEmail(name: string): string {
  return `e2e.qc775.t.${name}@quarryconnect.test`;
}

function landingUrl(): string {
  return env.landingUrl ?? 'https://www.quarryconnect.com/';
}

function cacheWindow(): number {
  return env.identityHostCacheSeconds * 1000;
}

async function expectLanding(url: string, expected: string | RegExp, message: string): Promise<void> {
  await expect
    .poll(() => identityLanding(url), { message, timeout: cacheWindow(), intervals: [2_000, 5_000, 10_000] })
    .toMatch(typeof expected === 'string' ? new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : expected);
}

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
  return context.newPage();
}

function throwawayHostUuid(): string {
  const uuid = queryMasterDb(`SELECT LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE HostKey = N'${THROWAWAY_HOST.key}'`);
  expect(uuid, 'the throwaway host is in HOST_MASTER').not.toBeNull();
  return uuid!;
}

test.describe('Identity holds no host information (QC-775)', () => {
  test.describe('where Identity sends people it cannot place', () => {
    test.use(signedOut);

    test('HMI-01 the Identity root sends everyone to the public site', { tag: '@smoke' }, async ({ request }) => {
      const response = await request.get(`${env.identityUrl}/`, { maxRedirects: 0 });
      expect(response.status()).toBe(302);
      expect(response.headers()['location']).toBe(landingUrl());
    });

    test('HMI-02 an unknown client or a return address the host did not allow ends on the public site, an allowed one on the sign-in page', async () => {
      test.skip(!env.hostClient, 'Needs the target host client (HOST_CLIENT_ID / HOST_REDIRECT_URI).');

      expect(await identityLanding(authorizeUrl({ client_id: 'e2e-qc775.no-such-client', redirect_uri: env.hostClient!.redirectUri }))).toBe(landingUrl());
      expect(await identityLanding(authorizeUrl({ client_id: env.hostClient!.clientId, redirect_uri: 'http://evil.example/' }))).toBe(landingUrl());
      expect(await identityLanding(authorizeUrl({ client_id: env.hostClient!.clientId, redirect_uri: `${env.hostClient!.redirectUri}not-allowed` }))).toBe(landingUrl());

      const allowed = await identityLanding(authorizeUrl({ client_id: env.hostClient!.clientId, redirect_uri: env.hostClient!.redirectUri }));
      expect(allowed).toMatch(new RegExp(`^${env.identityUrl}/Account/Login\\?ReturnUrl=`, 'i'));
    });
  });

  test.describe('a host that lives only in HOST_MASTER', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canUseMasterDb(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE, local only) for the throwaway host.');

    let hostUuid = '';

    test.beforeAll(() => {
      runMasterSeedScript('master-qc775-host.apply.sql');
      hostUuid = throwawayHostUuid();
    });

    test.afterAll(() => {
      runMasterSeedScript('master-qc775-host.remove.sql');
    });

    test('HMI-03 a new HOST_MASTER host is signed into through Identity with its own branding, and its dashboard card says sign-in is ready', async ({ browser, page }) => {
      test.setTimeout(cacheWindow() + 60_000);
      const flow = authorizeUrl({ client_id: THROWAWAY_HOST.client.clientId, redirect_uri: THROWAWAY_HOST.client.redirectUri });
      await expectLanding(flow, `${env.identityUrl}/Account/Login`, 'Identity reads the new host from the HOST_MASTER feed');

      const identity = await signedOutPage(browser);
      await new HostSignInFlow(identity, THROWAWAY_HOST.client).open();
      await new IdentityLoginPage(identity).expectVisible();
      await expect(identity).toHaveTitle(THROWAWAY_HOST.branding.displayName);
      await expect(identity.locator('body')).toHaveAttribute('data-client-id', THROWAWAY_HOST.client.clientId);
      await identity.context().close();

      const dashboard = new DashboardPage(page);
      await dashboard.open();
      await expect(dashboard.signInState(hostUuid)).toHaveText('Sign-in ready');
      await expect(dashboard.hostCard(hostUuid).getByRole('link', { name: 'Sign-in', exact: true })).toHaveAttribute('href', `#/hosts/${hostUuid}/sign-in`);
    });

    test('HMI-04 branding saved on the Admin Sign-in page shows on the host sign-in page once Identity reads the feed again', async ({ browser, page, shell }) => {
      test.setTimeout(2 * cacheWindow() + 90_000);
      const settings = new HostSignInSettingsPage(page);
      await settings.open(hostUuid);
      await expect(new HostNav(page).tab('sign-in')).toHaveClass(/active/);
      const original = await settings.readBranding();
      expect(original.displayName).toBe(THROWAWAY_HOST.branding.displayName);
      const changed: Partial<HostBranding> = { displayName: 'E2E QC-775 Rebranded', primaryColor: '#1f7a3a' };
      const identity = await signedOutPage(browser);
      const primaryColour = () => identity.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--daxaColor').trim());

      try {
        await settings.fillBranding(changed);
        await settings.brandingSave.click();
        await shell.expectStatus('Branding saved.');
        expect(queryMasterDb(`SELECT b.DisplayName FROM app.HostBrandings b JOIN app.Hosts h ON h.HostID = b.HostID_FK WHERE h.HostKey = N'${THROWAWAY_HOST.key}' AND b.Active = 1`)).toBe(changed.displayName);

        await settings.open(hostUuid);
        await expect(settings.branding('displayName')).toHaveValue(changed.displayName!);

        await expect
          .poll(
            async () => {
              await new HostSignInFlow(identity, THROWAWAY_HOST.client).open();
              return identity.title();
            },
            { message: 'the sign-in page shows the new display name', timeout: cacheWindow(), intervals: [2_000, 5_000, 10_000] },
          )
          .toBe(changed.displayName);
        expect(await primaryColour()).toBe(changed.primaryColor);
      } finally {
        await settings.open(hostUuid);
        if ((await settings.branding('displayName').inputValue()) !== original.displayName || (await settings.branding('primaryColor').inputValue()) !== original.primaryColor) {
          await settings.fillBranding(original);
          await settings.brandingSave.click();
          await shell.expectStatus('Branding saved.');
        }
      }

      await expect
        .poll(
          async () => {
            await new HostSignInFlow(identity, THROWAWAY_HOST.client).open();
            return identity.title();
          },
          { message: 'the sign-in page shows the original display name again', timeout: cacheWindow(), intervals: [2_000, 5_000, 10_000] },
        )
        .toBe(original.displayName);
      await identity.context().close();
    });

    test('HMI-05 the Sign-in page refuses an insecure logo, a bad colour, a relative return address and an empty return list, and saves nothing', async ({ page, shell }) => {
      const settings = new HostSignInSettingsPage(page);
      await settings.open(hostUuid);
      const branding = await settings.readBranding();
      const urls = await settings.readUrls();

      await settings.fillBranding({ logoUrl: 'http://insecure.example/logo.png', primaryColor: 'red' });
      await settings.brandingSave.click();
      await expect(settings.fieldError('logoUrl')).toHaveText("Enter the logo's full address, starting with https://.");
      await expect(settings.fieldError('primaryColor')).toHaveText('Use a colour like #2c72ee.');
      await expect(settings.fieldError('displayName')).toHaveCount(0);

      await settings.fillUrls({ returnUrls: ['/relative'] });
      await settings.urlsSave.click();
      await expect(settings.fieldError('returnUrls')).toHaveText("'/relative' is not a return address. Enter a full address starting with https://.");

      await settings.fillUrls({ returnUrls: [] });
      await settings.urlsSave.click();
      await expect(settings.fieldError('returnUrls')).toHaveText('Add at least one return address, or nobody can sign in to this host.');
      await shell.dismissSnackBars();

      await settings.open(hostUuid);
      expect(await settings.readBranding()).toEqual(branding);
      expect(await settings.readUrls()).toEqual(urls);
    });

    test('HMI-06 a return address added on the Sign-in page is accepted by Identity, and once removed sends people to the public site', async ({ page, shell }) => {
      test.setTimeout(2 * cacheWindow() + 90_000);
      const settings = new HostSignInSettingsPage(page);
      await settings.open(hostUuid);
      const original: HostAllowedUrls = await settings.readUrls();
      const extra = authorizeUrl({ client_id: THROWAWAY_HOST.client.clientId, redirect_uri: EXTRA_RETURN_URL });
      expect(await identityLanding(extra)).toBe(landingUrl());

      try {
        await settings.fillUrls({ returnUrls: [...original.returnUrls, EXTRA_RETURN_URL] });
        await settings.urlsSave.click();
        await shell.expectStatus('Allowed addresses saved.');
        await settings.open(hostUuid);
        expect((await settings.readUrls()).returnUrls).toEqual([...original.returnUrls, EXTRA_RETURN_URL]);

        await expectLanding(extra, `${env.identityUrl}/Account/Login`, 'Identity accepts the added return address');
      } finally {
        await settings.open(hostUuid);
        if (JSON.stringify(await settings.readUrls()) !== JSON.stringify(original)) {
          await settings.fillUrls(original);
          await settings.urlsSave.click();
          await shell.expectStatus('Allowed addresses saved.');
        }
      }

      await settings.open(hostUuid);
      expect(await settings.readUrls()).toEqual(original);
      await expectLanding(extra, landingUrl(), 'Identity drops the removed return address');
    });

    test('HMI-07 a host turned off in HOST_MASTER cannot be signed into, and can again once it is back on', async () => {
      test.setTimeout(2 * cacheWindow() + 60_000);
      const flow = authorizeUrl({ client_id: THROWAWAY_HOST.client.clientId, redirect_uri: THROWAWAY_HOST.client.redirectUri });
      const where = `HostKey = N'${THROWAWAY_HOST.key}'`;
      const original = queryMasterDb(`SELECT CAST(Active AS int) FROM app.Hosts WHERE ${where}`);
      expect(original).toBe('1');

      try {
        queryMasterDb(`UPDATE app.Hosts SET Active = 0 WHERE ${where}`);
        await expectLanding(flow, landingUrl(), 'Identity refuses the turned-off host');
      } finally {
        queryMasterDb(`UPDATE app.Hosts SET Active = ${Number(original)} WHERE ${where}`);
      }

      expect(queryMasterDb(`SELECT CAST(Active AS int) FROM app.Hosts WHERE ${where}`)).toBe(original);
      await expectLanding(flow, `${env.identityUrl}/Account/Login`, 'Identity accepts the host again');
    });

    test('HMI-19 the MFA switch saves straight to HOST_MASTER, and Identity then sends every user of that host to two-step set-up', async ({ browser, page, shell }) => {
      test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for a throwaway user.");
      test.setTimeout(cacheWindow() + 120_000);
      const user = seedIdentityUser(throwawayEmail('mfahost'), 'QC-775 MFA host', false);
      const features = new HostFeaturesPage(page);
      const mfaRow = () =>
        queryMasterDb(`SELECT CAST(f.IsEnabled AS int) FROM app.HostFeatures f JOIN app.Hosts h ON h.HostID = f.HostID_FK WHERE h.HostKey = N'${THROWAWAY_HOST.key}' AND f.Active = 1 AND f.FeatureKey = 'mfa'`);
      const openFeatures = async () => {
        await openAdmin(page, `/hosts/${hostUuid}/features`);
        await expect(features.mfaForm).toBeVisible();
      };
      await openFeatures();
      const original = await features.mfaOn();
      expect(original).toBe(false);

      try {
        await features.setMfa(true);
        await features.mfaSave.click();
        await shell.expectStatus('Two-step sign-in is now required at this host. It applies within 5 minutes.');
        expect(mfaRow()).toBe('1');

        await expect
          .poll(
            async () => {
              const identity = await signedOutPage(browser);
              try {
                await new HostSignInFlow(identity, THROWAWAY_HOST.client).signIn(user);
                await identity.waitForURL((url) => !/\/Account\/Login$/i.test(url.pathname), { timeout: 15_000 });
                return new URL(identity.url()).pathname;
              } finally {
                await identity.context().close();
              }
            },
            { message: 'Identity asks for two-step set-up at the host', timeout: cacheWindow(), intervals: [2_000, 5_000, 10_000] },
          )
          .toMatch(/\/Account\/EnableAuthenticator$/i);
      } finally {
        await openFeatures();
        if ((await features.mfaOn()) !== original) {
          await features.setMfa(original);
          await features.mfaSave.click();
          await shell.expectStatus('Two-step sign-in is no longer required at this host.');
        }
        removeIdentityUsers(user.email);
      }
      expect(mfaRow()).toBe('0');
    });
  });

  test.describe('tokens and the drivers API', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.use(signedOut);
    test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway drivers.");
    test.skip(!canUseDriversDb(), "Needs the drivers API's local database (DRIVERS_SQL_DATABASE) to link the throwaway driver to a host.");
    test.skip(!env.mobileClientId, 'Needs the mobile password-grant client (MOBILE_CLIENT_ID).');

    let driver: ThrowawayUser;
    let unlinked: ThrowawayUser;
    let driverTokens: TokenResponse;
    let unlinkedTokens: TokenResponse;

    test.beforeAll(async ({ playwright, targetHost }) => {
      driver = seedIdentityUser(throwawayEmail('driver'), 'QC-775 Driver', false);
      unlinked = seedIdentityUser(throwawayEmail('nohost'), 'QC-775 No host', false);
      runDriversSeedScript('drivers-qc775-link.apply.sql', { UserId: driver.userId, HostUuid: targetHost.uuid });

      const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        const api = new PasswordGrantApi(request);
        const first = await api.passwordGrant(driver.email, driver.password);
        expect(first.status, JSON.stringify(first.body)).toBe(200);
        driverTokens = first.body;
        const second = await api.passwordGrant(unlinked.email, unlinked.password);
        expect(second.status, JSON.stringify(second.body)).toBe(200);
        unlinkedTokens = second.body;
      } finally {
        await request.dispose();
      }
    });

    test.afterAll(() => {
      runDriversSeedScript('drivers-qc775.remove.sql', { UserIds: [driver?.userId, unlinked?.userId].filter(Boolean).join(',') });
      removeIdentityUsers(USERS);
    });

    test('HMI-08 a host sign-in gives access and id tokens with no role, organisation, host or hosts claim', async ({ page, request }) => {
      test.skip(!env.hostClient, 'Needs the target host client (HOST_CLIENT_ID / HOST_REDIRECT_URI).');
      const flow = new HostSignInFlow(page, env.hostClient!);
      await flow.signIn(driver);
      const tokens = await flow.tokens(request);

      expect(tokens.access.sub).toBe(driver.userId);
      expect(tokens.access.client_id).toBe(env.hostClient!.clientId);
      expect(tokens.id.sub).toBe(driver.userId);
      for (const claim of HOST_CLAIMS) {
        expect(tokens.access, `access token has no ${claim}`).not.toHaveProperty(claim);
        expect(tokens.id, `id token has no ${claim}`).not.toHaveProperty(claim);
      }
    });

    test('HMI-09 the mobile password grant returns no hosts list, and its token has no role or host claim', async () => {
      expect(driverTokens).not.toHaveProperty('hosts');
      const { claims } = decodeJwt(driverTokens.access_token!);
      expect(claims.client_id).toBe(env.mobileClientId);
      expect(claims.sub).toBe(driver.userId);
      for (const claim of HOST_CLAIMS) {
        expect(claims, `access token has no ${claim}`).not.toHaveProperty(claim);
      }
    });

    test('HMI-10 the drivers API lists the hosts a driver is linked to, and none for a driver with no link', async ({ request, targetHost }) => {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const api = new PasswordGrantApi(request);

      const linked = await api.driversMeHosts(driverTokens.access_token!);
      expect(linked.status()).toBe(200);
      const hosts = (await linked.json()).data.hosts as { hostUuid: string; name: string; logoUrl: string | null }[];
      expect(hosts).toHaveLength(1);
      expect(hosts[0].hostUuid.toLowerCase()).toBe(targetHost.uuid);
      expect(hosts[0].name).toBeTruthy();
      expect(Object.keys(hosts[0]).sort()).toEqual(['hostUuid', 'logoUrl', 'name']);

      const none = await api.driversMeHosts(unlinkedTokens.access_token!);
      expect(none.status()).toBe(200);
      expect((await none.json()).data.hosts).toEqual([]);

      expect((await request.get(`${env.driversApiUrl}/me/hosts`)).status()).toBe(401);
    });

    test('HMI-11 host-scoped drivers endpoints need the X-Host-Uuid of a linked host: 200 for it, 403 for none, another host or an unlinked driver', async ({ request, targetHost }) => {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const api = new PasswordGrantApi(request);
      const header = (uuid: string) => ({ headers: { 'X-Host-Uuid': uuid } });

      const chosen = await api.driversMeHost(driverTokens.access_token!, header(targetHost.uuid));
      expect(chosen.status()).toBe(200);
      expect(((await chosen.json()).data.hostUuid as string).toLowerCase()).toBe(targetHost.uuid);

      expect((await api.driversMeHost(driverTokens.access_token!)).status(), 'no header').toBe(403);
      expect((await api.driversMeHost(driverTokens.access_token!, header(randomUUID()))).status(), 'a host the driver is not linked to').toBe(403);
      expect((await api.driversMeHost(driverTokens.access_token!, header('not-a-uuid'))).status(), 'a malformed host').toBe(403);
      expect((await api.driversMeHost(unlinkedTokens.access_token!, header(targetHost.uuid))).status(), 'a driver with no link').toBe(403);

      const me = await api.driversMe(driverTokens.access_token!, header(targetHost.uuid));
      expect(me.status()).toBe(200);
      expect(((await me.json()).data.hostUuid as string).toLowerCase()).toBe(targetHost.uuid);
      const plain = await api.driversMe(driverTokens.access_token!);
      expect((await plain.json()).data.hostUuid).toBeNull();
      const elsewhere = await api.driversMe(driverTokens.access_token!, header(randomUUID()));
      expect((await elsewhere.json()).data.hostUuid, 'an unlinked host is ignored on /me').toBeNull();
    });

    test('HMI-12 the Driver UI picks the only linked host by itself and sends the no-host driver to the No host page', async ({ browser, request, targetHost }) => {
      test.skip(!env.driverUiClient, 'Needs the Driver UI client (DRIVER_UI_CLIENT_ID / DRIVER_UI_REDIRECT_URI).');
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      const driverUi = new URL(env.driverUiClient!.redirectUri).origin;
      test.skip(!(await request.get(driverUi).then((r) => r.ok()).catch(() => false)), `The Driver UI is not running on ${driverUi}.`);

      for (const [user, expectation] of [
        [driver, 'home'],
        [unlinked, 'no-host'],
      ] as const) {
        const page = await signedOutPage(browser);
        const authorizes: string[] = [];
        page.on('request', (r) => {
          if (r.url().startsWith(`${env.identityUrl}/connect/authorize?`)) authorizes.push(r.url());
        });
        await page.goto(`${driverUi}/`);
        await new IdentityLoginPage(page).signIn(user);
        expect(new URL(authorizes[0]).searchParams.get('client_id')).toBe(env.driverUiClient!.clientId);

        if (expectation === 'home') {
          await expect(page.locator('#chosen-host')).toBeVisible({ timeout: 30_000 });
          await expect(page.locator('#active-host')).toHaveText(new RegExp(targetHost.uuid, 'i'));
          const stored = await page.evaluate(() => localStorage.getItem('qc.drivers.host'));
          expect(JSON.parse(stored!).hostUuid.toLowerCase()).toBe(targetHost.uuid);
        } else {
          await expect(page.locator('#no-host-message')).toBeVisible({ timeout: 30_000 });
          expect(await page.evaluate(() => localStorage.getItem('qc.drivers.host'))).toBeNull();
        }
        await page.context().close();
      }
    });
  });

  test.describe('two-step verification', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedThrowawayUsers() || !canUseMasterDb(), "Needs Identity's local database, HOST_MASTER and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users.");

    let noTwoStepAdmin: ThrowawayUser;
    let member: ThrowawayUser;

    test.beforeAll(() => {
      noTwoStepAdmin = seedIdentityUser(throwawayEmail('nomfa'), 'QC-775 No two-step admin', false);
      makePlatformAdmin(noTwoStepAdmin, 'E2E QC-775 Test no two-step');
      member = seedIdentityUser(throwawayEmail('member'), 'QC-775 Member', true);
    });

    test.afterAll(() => {
      removePlatformAdmins(PLATFORM_ADMINS);
      removeIdentityUsers(USERS);
    });

    test('HMI-13 a platform admin without two-step verification is sent to set it up instead of into Admin', async ({ browser }) => {
      const page = await signedOutPage(browser);
      await page.goto(adminUrl('/'));
      await new IdentityLoginPage(page).signIn(noTwoStepAdmin);
      await new IdentityTwoStepPage(page).expectEnrolment();
      await expect(page.getByRole('heading', { name: 'Set up an authenticator app' })).toBeVisible();
      await expect(page).not.toHaveURL(new RegExp(`^${env.adminUrl}`));
      await page.context().close();
    });

    test('HMI-14 the Admin token carries mfa and the Admin API counts it; an admin session without it is shown the two-step message', async ({ page, request }) => {
      test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
      const token = adminTokenFromState();
      expect([decodeJwt(token).claims.amr].flat()).toContain('mfa');
      for (const claim of HOST_CLAIMS) {
        expect(decodeJwt(token).claims, `Admin token has no ${claim}`).not.toHaveProperty(claim);
      }
      expect((await AdminApi.asAdmin(request).get('/me')).body).toMatchObject({ isAdmin: true, needsTwoFactor: false });

      await page.route(`${env.adminApiUrl}/api/me`, (route) =>
        route.fulfill({ json: { userId: decodeJwt(token).claims.sub, name: 'E2E', email: 'e2e', isAdmin: false, needsTwoFactor: true } }),
      );
      await page.goto(adminUrl('/hosts'));
      await expect(page).toHaveURL(adminUrl('/permission-denied?reason=two-factor'));
      await expect(page.locator('#permission-denied-two-factor')).toContainText('Admins must sign in with two-step verification.');
      await expect(page.locator('#permission-denied-sign-out')).toBeVisible();
    });

    test('HMI-15 an account that is not a platform admin is refused by Admin even after two-step verification, and its token gets 403', async ({ browser, request }) => {
      test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
      const page = await signedOutPage(browser);
      await page.goto(adminUrl('/hosts'));
      await new IdentityLoginPage(page).signInWithTwoStep(member, member.authenticatorKey!);

      await expect(page).toHaveURL(adminUrl('/permission-denied'));
      await expect(page.locator('#permission-denied-message')).toContainText('Only platform admins can sign in here.');
      await expect(page.locator('#permission-denied-two-factor')).toHaveCount(0);

      const token = await accessTokenFromPage(page);
      expect(token).toBeTruthy();
      expect([decodeJwt(token!).claims.amr].flat()).toContain('mfa');
      const api = new AdminApi(request, token);
      expect((await api.get('/me')).body).toMatchObject({ userId: member.userId, isAdmin: false, needsTwoFactor: false });
      for (const path of ['/hosts', '/users', '/dashboard']) {
        expect((await api.get(path)).status, path).toBe(403);
      }
      await page.context().close();
    });

    test("HMI-16 the hosts feed for Identity refuses no token and a person's token", async ({ request }) => {
      test.skip(!canUseAdminApi(), 'ADMIN_API_URL is not set.');
      expect((await new AdminApi(request, null).get('/identity/hosts')).status).toBe(401);
      expect((await AdminApi.asAdmin(request).get('/identity/hosts')).status).toBe(403);
    });
  });

  test.describe('host administrators at the host app', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.use(signedOut);
    test.skip(!canSeedThrowawayUsers() || !canSeedLocalDb(), "Needs Identity's and the host's local databases and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admins.");
    test.skip(!env.hostClient || !env.appApiUrl, 'Needs the target host client (HOST_CLIENT_ID) and the host API (APP_API_URL).');

    let withoutTwoStep: ThrowawayUser;
    let withTwoStep: ThrowawayUser;

    test.beforeAll(() => {
      withoutTwoStep = seedIdentityUser(throwawayEmail('hostadmin'), 'QC-775 Host admin', false);
      withTwoStep = seedIdentityUser(throwawayEmail('hostadmin2'), 'QC-775 Host admin 2', true);
      for (const user of [withoutTwoStep, withTwoStep]) {
        runSeedScript('host-qc775-admin.apply.sql', { UserId: user.userId, Email: user.email });
      }
    });

    test.afterAll(() => {
      runSeedScript('host-qc775.remove.sql');
      removeIdentityUsers(USERS);
    });

    async function exchange(request: APIRequestContext, accessToken: string): Promise<number> {
      const response = await request.post(`${env.appApiUrl}/api/Account/IdentityExchange`, { data: { accessToken } });
      return response.status();
    }

    test("HMI-17 the host API refuses a host admin's Identity token without two-step verification and accepts one with it", async ({ browser, page, request }) => {
      const plain = new HostSignInFlow(page, env.hostClient!);
      await plain.signIn(withoutTwoStep);
      const plainTokens = await plain.tokens(request);
      expect([plainTokens.access.amr].flat()).not.toContain('mfa');
      expect(await exchange(request, plainTokens.accessToken)).toBe(403);

      const otherPage = await signedOutPage(browser);
      const stepped = new HostSignInFlow(otherPage, env.hostClient!);
      await stepped.open();
      await new IdentityLoginPage(otherPage).signInWithTwoStep(withTwoStep, withTwoStep.authenticatorKey!);
      const steppedTokens = await stepped.tokens(request);
      expect([steppedTokens.access.amr].flat()).toContain('mfa');
      expect(await exchange(request, steppedTokens.accessToken)).toBe(200);
      await otherPage.context().close();
    });

    test('HMI-18 the host app asks Identity again with acr_values=mfa when its API refuses a host admin, and Identity asks for two-step set-up', async ({ page, request }) => {
      test.skip(!env.appUrl, 'APP_URL is not set.');
      test.skip(!(await request.get(env.appUrl!).then((r) => r.ok()).catch(() => false)), `The host app is not running on ${env.appUrl}.`);
      const authorizes: URL[] = [];
      page.on('request', (r) => {
        if (r.url().startsWith(`${env.identityUrl}/connect/authorize?`)) authorizes.push(new URL(r.url()));
      });

      await page.goto(`${env.appUrl}/#/authentication`);
      await new IdentityLoginPage(page).signIn(withoutTwoStep);

      await expect.poll(() => authorizes.filter((u) => u.searchParams.get('acr_values') === 'mfa').length, { message: 'a second authorize asks for mfa', timeout: 30_000 }).toBe(1);
      expect(authorizes[0].searchParams.get('client_id')).toBe(env.hostClient!.clientId);
      expect(authorizes[0].searchParams.get('acr_values')).toBeNull();

      await expect(page, 'the step-up authorize is not overtaken by a plain one, so Identity asks again').toHaveURL(new RegExp(`^${env.identityUrl}/Account/Login`, 'i'));
      expect(authorizes.filter((u) => u.searchParams.get('acr_values') === null).length, 'only the first authorize goes without acr_values').toBe(1);
      const login = new IdentityLoginPage(page);
      await login.signIn(withoutTwoStep);
      await new IdentityTwoStepPage(page).expectEnrolment();
      await expect(page).not.toHaveURL(new RegExp(`^${env.appUrl}`));
    });
  });
});
