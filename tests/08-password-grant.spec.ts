import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, restoreIdentityPassword, snapshotIdentityPassword } from '../fixtures/localDb';
import { decodeJwt, PasswordGrantApi, type TokenResponse } from '../pages/PasswordGrantApi';
import { IdentityLoginPage, IdentityLogoutPage, IdentityPasswordResetPage } from '../pages/IdentityLoginPage';
import { canReadIdentityLog } from '../fixtures/identityLog';
import { env } from '../config/environment';

const ACCESS_TOKEN_SECONDS = 900;
const INVALID_CREDENTIALS = { error: 'invalid_grant', error_description: 'invalid_username_or_password' };
const MFA_REQUIRED = { error: 'invalid_grant', error_description: 'mfa_required' };

function driverWhere(): string {
  return `Email = '${env.driver!.email.replace(/'/g, "''")}'`;
}

function sqlValue(value: string | null): string {
  return value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;
}

test.describe('Mobile password grant (QC-706)', () => {
  test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
  test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD in env/<env>.secrets.env).');

  test.describe('a driver with valid credentials', () => {
    let issued: TokenResponse;

    test.beforeAll(async ({ playwright }) => {
      const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
      try {
        const result = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
        expect(result.status, JSON.stringify(result.body)).toBe(200);
        issued = result.body;
      } finally {
        await request.dispose();
      }
    });

    test('PWD-01 a driver gets a 15-minute drivers API access token and a refresh token', async () => {
      expect(issued.expires_in).toBe(ACCESS_TOKEN_SECONDS);
      expect(issued.refresh_token).toBeTruthy();
      expect(issued.scope?.split(' ')).toEqual(expect.arrayContaining(['quarryconnect.drivers.api', 'offline_access']));

      const { header, claims } = decodeJwt(issued.access_token!);
      expect(header.typ).toBe('at+jwt');
      expect(claims.client_id).toBe(env.mobileClientId);
      expect(claims.aud).toEqual(expect.arrayContaining(['quarryconnect.drivers.api']));
      expect(claims.role).toBe('Driver');
      expect(claims.amr).toEqual(['pwd']);
      expect(Number(claims.exp) - Number(claims.iat)).toBe(ACCESS_TOKEN_SECONDS);
    });

    test('PWD-02 the drivers API accepts the token and knows the driver', async ({ request }) => {
      test.skip(!env.driversApiUrl, 'The drivers API is not configured for this environment (DRIVERS_API_URL).');
      const api = new PasswordGrantApi(request);

      const me = await api.driversMe(issued.access_token!);
      expect(me.status()).toBe(200);
      expect((await me.json()).data).toMatchObject({ userUuid: decodeJwt(issued.access_token!).claims.sub, role: 'Driver' });

      const anonymous = await request.get(`${env.driversApiUrl}/me`);
      expect(anonymous.status()).toBe(401);
    });

    test('PWD-03 a refresh returns a new token pair and the old refresh token cannot be used again', async ({ request }) => {
      const api = new PasswordGrantApi(request);

      const refreshed = await api.refresh(issued.refresh_token!);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.access_token).toBeTruthy();
      expect(refreshed.body.refresh_token).toBeTruthy();
      expect(refreshed.body.refresh_token).not.toBe(issued.refresh_token);

      const replay = await api.refresh(issued.refresh_token!);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe('invalid_grant');
    });
  });

  test('PWD-04 an unknown email is refused without saying why', async ({ request }) => {
    const result = await new PasswordGrantApi(request).passwordGrant('nobody-pwd04@quarryconnect.test', 'Not-a-real-password-1');
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject(INVALID_CREDENTIALS);
  });

  test('PWD-05 a user without the Driver role is refused even with the right password', async ({ request }) => {
    test.skip(!env.admin, 'Needs the seeded admin test account (ADMIN_EMAIL / ADMIN_PASSWORD).');
    const result = await new PasswordGrantApi(request).passwordGrant(env.admin!.email, env.admin!.password);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject(INVALID_CREDENTIALS);
  });

  test.describe('driver account states', { tag: '@write' }, () => {
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to change and restore the test driver.");

    test('PWD-06 a deactivated driver is refused', async ({ request }) => {
      const original = queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE ${driverWhere()}`);
      expect(original, 'the test driver exists in Identity').not.toBeNull();

      try {
        queryIdentityDb(`UPDATE Users SET IsActive = 0 WHERE ${driverWhere()}`);
        const result = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
        expect(result.status).toBe(400);
        expect(result.body).toMatchObject(INVALID_CREDENTIALS);
      } finally {
        queryIdentityDb(`UPDATE Users SET IsActive = ${Number(original)} WHERE ${driverWhere()}`);
      }
    });

    test('PWD-07 a driver who needs two-step verification is refused with mfa_required', async ({ request }) => {
      const original = queryIdentityDb(`SELECT CAST(TwoFactorEnabled AS int) FROM Users WHERE ${driverWhere()}`);
      expect(original, 'the test driver exists in Identity').not.toBeNull();

      try {
        queryIdentityDb(`UPDATE Users SET TwoFactorEnabled = 1 WHERE ${driverWhere()}`);
        const result = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
        expect(result.status).toBe(400);
        expect(result.body).toMatchObject(MFA_REQUIRED);
      } finally {
        queryIdentityDb(`UPDATE Users SET TwoFactorEnabled = ${Number(original)} WHERE ${driverWhere()}`);
      }
    });

    test('PWD-08 a wrong password counts towards the account lockout and a locked driver is refused', async ({ request }) => {
      const failedCount = queryIdentityDb(`SELECT AccessFailedCount FROM Users WHERE ${driverWhere()}`);
      const lockoutEnd = queryIdentityDb(`SELECT CONVERT(nvarchar(40), LockoutEnd, 127) FROM Users WHERE ${driverWhere()}`);
      expect(failedCount, 'the test driver exists in Identity').not.toBeNull();
      const api = new PasswordGrantApi(request);

      try {
        queryIdentityDb(`UPDATE Users SET AccessFailedCount = 4, LockoutEnd = NULL WHERE ${driverWhere()}`);

        const wrong = await api.passwordGrant(env.driver!.email, 'Wrong-password-pwd08');
        expect(wrong.status).toBe(400);
        expect(wrong.body).toMatchObject(INVALID_CREDENTIALS);

        const lockedUntil = queryIdentityDb(
          `SELECT CASE WHEN LockoutEnd > SYSDATETIMEOFFSET() THEN 'locked' ELSE 'open' END FROM Users WHERE ${driverWhere()}`,
        );
        expect(lockedUntil).toBe('locked');

        const right = await api.passwordGrant(env.driver!.email, env.driver!.password);
        expect(right.status).toBe(400);
        expect(right.body).toMatchObject(INVALID_CREDENTIALS);
      } finally {
        queryIdentityDb(
          `UPDATE Users SET AccessFailedCount = ${Number(failedCount)}, LockoutEnd = ${sqlValue(lockoutEnd)} WHERE ${driverWhere()}`,
        );
      }
    });
  });

  test('PWD-09 more than 20 attempts from one IP in 15 minutes are refused', async () => {
    test.skip(true, 'Tripping the per-IP throttle blocks every password grant from this machine for 15 minutes, so the other PWD cases and later runs would fail. Checked by hand on 2026-10-14: the 21st attempt returned invalid_grant and logged "too many attempts".');
  });
});

test.describe('Refresh token revocation (QC-708)', () => {
  test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
  test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD in env/<env>.secrets.env).');

  async function signInDriver(api: PasswordGrantApi): Promise<TokenResponse> {
    const result = await api.passwordGrant(env.driver!.email, env.driver!.password);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body;
  }

  test('PWD-12 a refresh token the app revokes can no longer be used', async ({ request }) => {
    const api = new PasswordGrantApi(request);
    const issued = await signInDriver(api);

    expect(await api.revoke(issued.refresh_token!)).toBe(200);

    const refreshed = await api.refresh(issued.refresh_token!);
    expect(refreshed.status).toBe(400);
    expect(refreshed.body.error).toBe('invalid_grant');
  });

  test('PWD-13 signing out on the web leaves the mobile refresh token working', async ({ browser, request }) => {
    const api = new PasswordGrantApi(request);
    const issued = await signInDriver(api);

    const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      const page = await context.newPage();
      await page.goto(`${env.identityUrl}/Account/Login`);
      const login = new IdentityLoginPage(page);
      await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/Account/Login')),
        login.signIn(env.driver!),
      ]);
      await new IdentityLogoutPage(page).signOutHere();
    } finally {
      await context.close();
    }

    const refreshed = await api.refresh(issued.refresh_token!);
    expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
  });

  test.describe('driver account changes', { tag: '@write' }, () => {
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to change and restore the test driver.");

    function storedGrants(): number {
      return Number(queryIdentityDb(`SELECT COUNT(*) FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.${driverWhere()}`));
    }

    test('PWD-10 a password change stops the refresh token and clears the stored grants', async ({ request }) => {
      const api = new PasswordGrantApi(request);
      const issued = await signInDriver(api);
      const originalStamp = queryIdentityDb(`SELECT SecurityStamp FROM Users WHERE ${driverWhere()}`);
      expect(storedGrants()).toBeGreaterThan(0);

      try {
        queryIdentityDb(`UPDATE Users SET SecurityStamp = CONVERT(nvarchar(36), NEWID()) WHERE ${driverWhere()}`);

        const refreshed = await api.refresh(issued.refresh_token!);
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');
        expect(storedGrants()).toBe(0);
      } finally {
        queryIdentityDb(`UPDATE Users SET SecurityStamp = ${sqlValue(originalStamp)} WHERE ${driverWhere()}`);
      }
    });

    test('PWD-11 a deactivated driver cannot refresh and the stored grants are cleared', async ({ request }) => {
      const api = new PasswordGrantApi(request);
      const issued = await signInDriver(api);
      const original = queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE ${driverWhere()}`);
      expect(storedGrants()).toBeGreaterThan(0);

      try {
        queryIdentityDb(`UPDATE Users SET IsActive = 0 WHERE ${driverWhere()}`);

        const refreshed = await api.refresh(issued.refresh_token!);
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');
        expect(storedGrants()).toBe(0);
      } finally {
        queryIdentityDb(`UPDATE Users SET IsActive = ${Number(original)} WHERE ${driverWhere()}`);
      }
    });

    test('PWD-14 resetting the password on the Identity pages stops the mobile refresh token', async ({ browser, request }) => {
      test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR), where Development writes the reset link when no mail server is set.");
      const api = new PasswordGrantApi(request);
      const issued = await signInDriver(api);
      const password = snapshotIdentityPassword(driverWhere());
      const context = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
      const reset = new IdentityPasswordResetPage(await context.newPage());

      try {
        await reset.resetVia(env.driver!.email, 'Pwd14-Temporary-Reset!');

        const refreshed = await api.refresh(issued.refresh_token!);
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');
        expect(storedGrants()).toBe(0);

        const old = await api.passwordGrant(env.driver!.email, env.driver!.password);
        expect(old.status).toBe(400);
      } finally {
        restoreIdentityPassword(driverWhere(), password);
        await context.close();
      }

      expect((await api.passwordGrant(env.driver!.email, env.driver!.password)).status).toBe(200);
    });
  });
});
