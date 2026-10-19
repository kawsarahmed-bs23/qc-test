import { test, expect } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb, runIdentitySeedScript } from '../fixtures/localDb';
import { canReadIdentityLog, identityLogSince, markIdentityLog, resetCodeSince } from '../fixtures/identityLog';
import { decodeJwt, PasswordGrantApi, type TokenResponse, type TokenResult } from '../pages/PasswordGrantApi';
import { env } from '../config/environment';

const RUN = Date.now();
const RESET_USER = `e2e.qc709.reset.${RUN}@quarryconnect.test`;
const LIMITS_USER = `e2e.qc709.limits.${RUN}@quarryconnect.test`;
const RESET_PASSWORD = 'Acc709-Reset-Pass!';
const CHANGED_PASSWORD = 'Acc709-Changed-Pass!';
const WEAK_PASSWORD = 'weakpassword';
const ACCESS_TOKEN_SECONDS = 900;
const INVALID_CREDENTIALS = { error: 'invalid_grant', error_description: 'invalid_username_or_password' };
const GRANT_THROTTLE_LINE = 'Password grant refused: too many attempts';
const GRANT_THROTTLED =
  "Identity's per-IP password-grant throttle (20 per 15 minutes) is spent by the earlier specs in this run; run the ACC cases on their own after restarting Identity.";

function userWhere(email: string): string {
  return `NormalizedEmail = UPPER(N'${email}')`;
}

function userId(email: string): string {
  return queryIdentityDb(`SELECT Id FROM Users WHERE ${userWhere(email)}`)!;
}

function passwordHash(email: string): string | null {
  return queryIdentityDb(`SELECT CONVERT(char(64), HASHBYTES('SHA2_256', PasswordHash), 2) FROM Users WHERE ${userWhere(email)}`);
}

function openCodeAttempts(email: string): number | null {
  const attempts = queryIdentityDb(
    `SELECT TOP 1 c.Attempts FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.${userWhere(email)} AND c.Consumed IS NULL ORDER BY c.Created DESC`,
  );
  return attempts === null ? null : Number(attempts);
}

function storedGrants(email: string): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.${userWhere(email)}`));
}

function anotherCode(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, '0');
}

async function requestCode(api: PasswordGrantApi, email: string): Promise<string> {
  const mark = markIdentityLog();
  const result = await api.forgotPasswordCode(email);
  expect(result.status).toBe(202);
  expect(result.body).toBeNull();
  await expect.poll(() => resetCodeSince(mark, email), { message: 'reset code in the Identity log' }).toMatch(/^\d{6}$/);
  return resetCodeSince(mark, email)!;
}

async function grant(call: () => Promise<TokenResult>): Promise<TokenResult> {
  const mark = markIdentityLog();
  const result = await call();
  test.skip(identityLogSince(mark).includes(GRANT_THROTTLE_LINE), GRANT_THROTTLED);
  return result;
}

test.describe('Mobile account API (QC-709)', () => {
  test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
  test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR): Development writes the reset code there when no mail server is set.");

  test('ACC-01 a code request for an unknown email is accepted with an empty body and sends nothing', async ({ request }) => {
    const email = `acc01-${RUN}@quarryconnect.test`;
    const mark = markIdentityLog();

    const result = await new PasswordGrantApi(request).forgotPasswordCode(email);

    expect(result.status).toBe(202);
    expect(result.body).toBeNull();
    await expect.poll(() => identityLogSince(mark)).toContain(`Password reset code requested for unknown email ${email}`);
    expect(resetCodeSince(mark, email)).toBeNull();
  });

  test('ACC-02 a code for an unknown email is refused with invalid_code', async ({ request }) => {
    const result = await new PasswordGrantApi(request).resetWithCode(`acc02-${RUN}@quarryconnect.test`, '123456', RESET_PASSWORD);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_code' });
  });

  test('ACC-03 a bad body or a client that is not an active mobile-driver client is refused with invalid_request', async ({ request }) => {
    const api = new PasswordGrantApi(request);
    const email = `acc03-${RUN}@quarryconnect.test`;
    const refusals = [
      await api.forgotPasswordCode(email, 'e2e-qc709.unknown-client'),
      await api.forgotPasswordCode('not-an-email'),
      await api.accountApi('forgot', { clientId: env.mobileClientId }),
      await api.resetWithCode(email, '123456', RESET_PASSWORD, 'e2e-qc709.unknown-client'),
      await api.accountApi('reset', { clientId: env.mobileClientId, email, newPassword: RESET_PASSWORD }),
    ];
    if (env.hostClient) {
      refusals.push(await api.forgotPasswordCode(email, env.hostClient.clientId));
    }

    for (const refusal of refusals) {
      expect(refusal.status).toBe(400);
      expect(refusal.body?.error).toBe('invalid_request');
    }
  });

  test.describe('reset with a code, then change the password', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD), whose password hash the throwaway driver copies.');
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to seed and remove the throwaway driver.");

    let beforeReset: TokenResponse | undefined;
    let code: string | undefined;
    let afterReset: TokenResponse | undefined;
    let resetDone = false;

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc709-driver.apply.sql', { Email: RESET_USER, SourceEmail: env.driver!.email, MobileClientId: env.mobileClientId! });
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc709.remove.sql');
    });

    test('ACC-04 a code request for an active driver emails a 6-digit code that is open for 15 minutes and 5 tries', async ({ request }) => {
      const api = new PasswordGrantApi(request);

      code = await requestCode(api, RESET_USER);

      const row = queryIdentityDb(
        `SELECT CONCAT(c.Attempts, '|', c.ClientId, '|', DATEDIFF(second, c.Created, c.Expires)) FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.${userWhere(RESET_USER)} AND c.Consumed IS NULL`,
      );
      expect(row).toBe(`0|${env.mobileClientId}|900`);

      const signIn = await grant(() => api.passwordGrant(RESET_USER, env.driver!.password));
      expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
      beforeReset = signIn.body;
    });

    test('ACC-05 a wrong code is refused with invalid_code and uses up one try', async ({ request }) => {
      test.skip(!code, 'ACC-04 did not get a code.');

      const result = await new PasswordGrantApi(request).resetWithCode(RESET_USER, anotherCode(code!), RESET_PASSWORD);

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'invalid_code' });
      expect(openCodeAttempts(RESET_USER)).toBe(1);
    });

    test('ACC-06 a new password that breaks the policy is refused with invalid_password and the reasons, without using up a try', async ({ request }) => {
      test.skip(!code, 'ACC-04 did not get a code.');
      const hash = passwordHash(RESET_USER);

      const result = await new PasswordGrantApi(request).resetWithCode(RESET_USER, code!, WEAK_PASSWORD);

      expect(result.status).toBe(400);
      expect(result.body?.error).toBe('invalid_password');
      expect(result.body?.errors?.length).toBeGreaterThan(0);
      expect(openCodeAttempts(RESET_USER)).toBe(1);
      expect(passwordHash(RESET_USER)).toBe(hash);
    });

    test('ACC-07 the right code resets the password, ends the old refresh token, and only the new password signs in', async ({ request }) => {
      test.skip(!code, 'ACC-04 did not get a code.');
      const api = new PasswordGrantApi(request);
      const grantsBefore = storedGrants(RESET_USER);

      const result = await api.resetWithCode(RESET_USER, code!, RESET_PASSWORD);

      expect(result.status).toBe(204);
      expect(result.body).toBeNull();
      resetDone = true;
      expect(openCodeAttempts(RESET_USER)).toBeNull();
      expect(storedGrants(RESET_USER)).toBe(0);
      test.skip(!beforeReset, GRANT_THROTTLED);
      expect(grantsBefore).toBeGreaterThan(0);

      const refreshed = await api.refresh(beforeReset!.refresh_token!);
      expect(refreshed.status).toBe(400);
      expect(refreshed.body.error).toBe('invalid_grant');

      const old = await grant(() => api.passwordGrant(RESET_USER, env.driver!.password));
      expect(old.status).toBe(400);
      expect(old.body).toMatchObject(INVALID_CREDENTIALS);

      const signIn = await grant(() => api.passwordGrant(RESET_USER, RESET_PASSWORD));
      expect(signIn.status, JSON.stringify(signIn.body)).toBe(200);
      afterReset = signIn.body;
    });

    test('ACC-08 a code that has been used is refused with invalid_code', async ({ request }) => {
      test.skip(!resetDone, 'ACC-07 did not reset the password.');
      const hash = passwordHash(RESET_USER);

      const result = await new PasswordGrantApi(request).resetWithCode(RESET_USER, code!, 'Acc709-Reused-Pass!');

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'invalid_code' });
      expect(passwordHash(RESET_USER)).toBe(hash);
    });

    test('ACC-09 change password with a wrong current password is invalid_username_or_password, and no new password is invalid_request', async ({ request }) => {
      test.skip(!resetDone, 'ACC-07 did not reset the password.');
      const api = new PasswordGrantApi(request);
      const hash = passwordHash(RESET_USER);

      const missing = await api.changePassword(RESET_USER, RESET_PASSWORD, null);
      expect(missing.status).toBe(400);
      expect(missing.body.error).toBe('invalid_request');

      const wrong = await grant(() => api.changePassword(RESET_USER, 'Acc709-Wrong-Current!', CHANGED_PASSWORD));
      expect(wrong.status).toBe(400);
      expect(wrong.body).toMatchObject(INVALID_CREDENTIALS);
      expect(wrong.body.access_token).toBeUndefined();
      expect(passwordHash(RESET_USER)).toBe(hash);
    });

    test('ACC-10 change password to one that breaks the policy is password_rejected with password_errors', async ({ request }) => {
      test.skip(!resetDone, 'ACC-07 did not reset the password.');
      const hash = passwordHash(RESET_USER);

      const weak = await grant(() => new PasswordGrantApi(request).changePassword(RESET_USER, RESET_PASSWORD, WEAK_PASSWORD));

      expect(weak.status).toBe(400);
      expect(weak.body).toMatchObject({ error: 'invalid_grant', error_description: 'password_rejected' });
      expect(weak.body.password_errors?.length).toBeGreaterThan(0);
      expect(weak.body.access_token).toBeUndefined();
      expect(passwordHash(RESET_USER)).toBe(hash);
    });

    test('ACC-11 a valid change returns a new token pair, ends the old refresh token, and the new tokens work', async ({ request }) => {
      test.skip(!env.driversApiUrl, 'The drivers API is not configured for this environment (DRIVERS_API_URL).');
      test.skip(!afterReset, GRANT_THROTTLED);
      const api = new PasswordGrantApi(request);
      const hash = passwordHash(RESET_USER);

      const changed = await grant(() => api.changePassword(RESET_USER, RESET_PASSWORD, CHANGED_PASSWORD));

      expect(changed.status, JSON.stringify(changed.body)).toBe(200);
      expect(changed.body.expires_in).toBe(ACCESS_TOKEN_SECONDS);
      expect(changed.body.refresh_token).toBeTruthy();
      expect(changed.body.refresh_token).not.toBe(afterReset!.refresh_token);
      expect(passwordHash(RESET_USER)).not.toBe(hash);
      const { claims } = decodeJwt(changed.body.access_token!);
      expect(claims.sub).toBe(userId(RESET_USER));
      expect(claims.client_id).toBe(env.mobileClientId);
      expect(claims.role).toBe('Driver');

      const stale = await api.refresh(afterReset!.refresh_token!);
      expect(stale.status).toBe(400);
      expect(stale.body.error).toBe('invalid_grant');

      const me = await api.driversMe(changed.body.access_token!);
      expect(me.status()).toBe(200);
      expect((await me.json()).data).toMatchObject({ userUuid: claims.sub, role: 'Driver' });

      const refreshed = await api.refresh(changed.body.refresh_token!);
      expect(refreshed.status, JSON.stringify(refreshed.body)).toBe(200);
      expect(refreshed.body.access_token).toBeTruthy();
      expect(refreshed.body.refresh_token).toBeTruthy();
    });

    test('ACC-12 a code older than 15 minutes is refused with invalid_code', async ({ request }) => {
      const api = new PasswordGrantApi(request);
      const fresh = await requestCode(api, RESET_USER);
      queryIdentityDb(
        `UPDATE c SET Expires = DATEADD(second, -1, SYSDATETIMEOFFSET()) FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.${userWhere(RESET_USER)} AND c.Consumed IS NULL`,
      );
      const hash = passwordHash(RESET_USER);

      const result = await api.resetWithCode(RESET_USER, fresh, 'Acc709-Expired-Pass!');

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'invalid_code' });
      expect(passwordHash(RESET_USER)).toBe(hash);
    });
  });

  test.describe('code limits', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD), whose password hash the throwaway driver copies.');
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to seed and remove the throwaway driver.");

    let retired: string | undefined;
    let current: string | undefined;

    test.beforeAll(() => {
      runIdentitySeedScript('identity-qc709-driver.apply.sql', { Email: LIMITS_USER, SourceEmail: env.driver!.email, MobileClientId: env.mobileClientId! });
    });

    test.afterAll(() => {
      runIdentitySeedScript('identity-qc709.remove.sql');
    });

    test('ACC-13 a deactivated driver is accepted with an empty body and sends nothing', async ({ request }) => {
      const mark = markIdentityLog();

      try {
        queryIdentityDb(`UPDATE Users SET IsActive = 0 WHERE ${userWhere(LIMITS_USER)}`);
        const result = await new PasswordGrantApi(request).forgotPasswordCode(LIMITS_USER);

        expect(result.status).toBe(202);
        expect(result.body).toBeNull();
        await expect.poll(() => identityLogSince(mark)).toContain(`Password reset code requested for deactivated user ${userId(LIMITS_USER)}`);
        expect(resetCodeSince(mark, LIMITS_USER)).toBeNull();
        expect(openCodeAttempts(LIMITS_USER)).toBeNull();
      } finally {
        queryIdentityDb(`UPDATE Users SET IsActive = 1 WHERE ${userWhere(LIMITS_USER)}`);
      }
    });

    test('ACC-14 a new code request retires the previous code', async ({ request }) => {
      const api = new PasswordGrantApi(request);
      retired = await requestCode(api, LIMITS_USER);
      current = await requestCode(api, LIMITS_USER);
      test.skip(retired === current, 'The two random codes happened to match, so the retired one cannot be told apart.');
      expect(Number(queryIdentityDb(`SELECT COUNT(*) FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.${userWhere(LIMITS_USER)} AND c.Consumed IS NULL`))).toBe(1);
      const hash = passwordHash(LIMITS_USER);

      const result = await api.resetWithCode(LIMITS_USER, retired, 'Acc709-Retired-Pass!');

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: 'invalid_code' });
      expect(openCodeAttempts(LIMITS_USER)).toBe(1);
      expect(passwordHash(LIMITS_USER)).toBe(hash);
    });

    test('ACC-15 after 5 wrong tries even the right code is refused and the password is unchanged', async ({ request }) => {
      test.skip(!current, 'ACC-14 did not get a code.');
      const api = new PasswordGrantApi(request);
      const hash = passwordHash(LIMITS_USER);
      const wrong = anotherCode(current!) === retired ? anotherCode(anotherCode(current!)) : anotherCode(current!);

      for (let tries = openCodeAttempts(LIMITS_USER) ?? 5; tries < 5; tries++) {
        const result = await api.resetWithCode(LIMITS_USER, wrong, 'Acc709-Wrong-Pass!');
        expect(result.body).toEqual({ error: 'invalid_code' });
      }
      expect(openCodeAttempts(LIMITS_USER)).toBe(5);

      const right = await api.resetWithCode(LIMITS_USER, current!, 'Acc709-Locked-Pass!');

      expect(right.status).toBe(400);
      expect(right.body).toEqual({ error: 'invalid_code' });
      expect(passwordHash(LIMITS_USER)).toBe(hash);
    });

    test('ACC-16 a fourth code request for one address within 15 minutes is accepted but sends nothing', async ({ request }) => {
      const mark = markIdentityLog();

      const result = await new PasswordGrantApi(request).forgotPasswordCode(LIMITS_USER);

      expect(result.status).toBe(202);
      expect(result.body).toBeNull();
      expect(identityLogSince(mark)).toContain(`Password reset code request throttled: too many requests for email ${LIMITS_USER}`);
      expect(resetCodeSince(mark, LIMITS_USER)).toBeNull();
    });
  });
});

test('ACC-17 the password policy endpoint returns the rules Identity enforces', async ({ request }) => {
  const result = await new PasswordGrantApi(request).passwordPolicy();

  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    requiredLength: 10,
    requireUppercase: true,
    requireLowercase: true,
    requireDigit: true,
    requireNonAlphanumeric: true,
    requiredUniqueChars: 1,
  });
});
