import type { APIRequestContext, Browser, BrowserContext } from '@playwright/test';
import { test, expect, signedOut } from '../fixtures/test';
import { env } from '../config/environment';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue } from '../fixtures/localDb';
import type { ThrowawayUser } from '../fixtures/throwawayUsers';
import {
  DEVICE_ID_CLAIM,
  deviceIdClaimValue,
  HostAccountApi,
  hostUserId,
  identityAccessToken,
  qc726Email,
  removeQc726HostUsers,
  seedQc726HostUser,
  type HostTokens,
} from '../pages/HostAccountApi';

const SIGN_INS = 10;
const DEVICE_A = 'qc726-device-a';
const DEVICE_B = 'qc726-device-b';

function claimRows(userId: string): number {
  return Number(querySingleValue(`SELECT COUNT(*) FROM auth.UserClaims WHERE UserId = N'${userId}'`));
}

function deviceClaimValues(userId: string): string[] {
  const values = querySingleValue(
    `SELECT STRING_AGG(ClaimValue, ',') FROM auth.UserClaims WHERE UserId = N'${userId}' AND ClaimType = N'${DEVICE_ID_CLAIM}'`,
  );
  return values === null ? [] : values.split(',');
}

const identitySessions = new Map<string, BrowserContext>();

async function hostSignIn(browser: Browser, request: APIRequestContext, user: ThrowawayUser, deviceId: string | null): Promise<HostTokens> {
  let context = identitySessions.get(user.email);
  if (!context) {
    context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    identitySessions.set(user.email, context);
  }
  const page = await context.newPage();
  try {
    const identityToken = await identityAccessToken(page, request, user, user.authenticatorKey);
    const exchange = await new HostAccountApi(request).identityExchange(identityToken, deviceId);
    expect(exchange.status, JSON.stringify(exchange.body)).toBe(200);
    expect(exchange.data?.accessToken).toBeTruthy();
    expect(exchange.data?.refreshToken).toBeTruthy();
    expect(hostUserId(exchange.data!)).toBe(user.userId);
    return exchange.data!;
  } finally {
    await page.close();
  }
}

test.describe('Host API sign-in stores only the device claim (QC-726)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.use(signedOut);
  test.skip(!canSeedLocalDb() || !canUseIdentityDb() || !env.admin, "Needs Identity's and the host's local databases and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users.");
  test.skip(!env.appApiUrl, 'APP_API_URL (the host API) is not set for this environment.');
  test.skip(!env.hostClient, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI) to get an Identity token for the identity exchange.');

  let admin: ThrowawayUser;
  let driver: ThrowawayUser;
  let adminTokens: HostTokens | undefined;
  let driverTokens: HostTokens | undefined;

  test.beforeAll(() => {
    removeQc726HostUsers();
    admin = seedQc726HostUser(qc726Email('admin'), 'Admin', true);
    driver = seedQc726HostUser(qc726Email('driver'), 'Driver', false);
  });

  test.afterAll(async () => {
    for (const context of identitySessions.values()) await context.close();
    identitySessions.clear();
    removeQc726HostUsers();
  });

  test('SIGNIN-01 a web sign-in without a device id stores no claim rows for the user, however often it is repeated', async ({ browser, request }) => {
    test.setTimeout(180_000);
    expect(claimRows(admin.userId)).toBe(0);

    for (let i = 1; i <= SIGN_INS; i++) {
      adminTokens = await hostSignIn(browser, request, admin, null);
      expect(claimRows(admin.userId), `auth.UserClaims rows for the admin after sign-in ${i}`).toBe(0);
    }
  });

  test('SIGNIN-02 repeated sign-ins from one device keep exactly one DeviceId row holding that device hash', async ({ browser, request }) => {
    test.setTimeout(180_000);
    expect(claimRows(driver.userId)).toBe(0);

    for (let i = 1; i <= SIGN_INS; i++) {
      driverTokens = await hostSignIn(browser, request, driver, DEVICE_A);
      expect(claimRows(driver.userId), `auth.UserClaims rows for the driver after sign-in ${i}`).toBe(1);
      expect(deviceClaimValues(driver.userId)).toEqual([deviceIdClaimValue(DEVICE_A)]);
    }
  });

  test('SIGNIN-03 a sign-in from another device replaces the DeviceId row instead of adding one', async ({ browser, request }) => {
    test.skip(!driverTokens, 'SIGNIN-02 did not sign the driver in.');

    driverTokens = await hostSignIn(browser, request, driver, DEVICE_B);

    expect(claimRows(driver.userId)).toBe(1);
    expect(deviceClaimValues(driver.userId)).toEqual([deviceIdClaimValue(DEVICE_B)]);
  });

  test('SIGNIN-04 a refreshed token pair still authorises host API calls and the refresh stores no claims', async ({ request }) => {
    test.skip(!adminTokens || !driverTokens, 'SIGNIN-01 or SIGNIN-03 did not leave a token pair.');
    const api = new HostAccountApi(request);

    const driverRefresh = await api.refresh(driverTokens!, DEVICE_B);
    expect(driverRefresh.status, JSON.stringify(driverRefresh.body)).toBe(200);
    const profile = await api.userProfile(driverRefresh.data!.accessToken, DEVICE_B);
    expect(profile.status, JSON.stringify(profile.body)).toBe(200);

    const adminRefresh = await api.refresh(adminTokens!);
    expect(adminRefresh.status, JSON.stringify(adminRefresh.body)).toBe(200);
    const threads = await api.commsThreads(adminRefresh.data!.accessToken);
    expect(threads.status, JSON.stringify(threads.body)).toBe(200);
    adminTokens = adminRefresh.data!;

    expect(claimRows(admin.userId)).toBe(0);
    expect(claimRows(driver.userId)).toBe(1);
    expect(deviceClaimValues(driver.userId)).toEqual([deviceIdClaimValue(DEVICE_B)]);
  });

  test('SIGNIN-05 the comms thread still reports that a driver with a stored device uses the app', async ({ request }) => {
    test.skip(!adminTokens || !driverTokens, 'SIGNIN-01 or SIGNIN-03 did not sign in.');

    const thread = await new HostAccountApi(request).commsThread(driver.userId, adminTokens!.accessToken);

    expect(thread.status, JSON.stringify(thread.body)).toBe(200);
    expect(thread.data?.driverUsesApp).toBe(true);
  });
});
