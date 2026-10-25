import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb } from '../fixtures/localDb';
import { canSeedThrowawayUsers, removeIdentityUsers, seedIdentityUser } from '../fixtures/throwawayUsers';
import { canReadIdentityLog, identityLogSince, markIdentityLog } from '../fixtures/identityLog';
import { IdentityLoginPage, IdentityLogoutPage, IdentityPasswordResetPage } from '../pages/IdentityLoginPage';
import { env } from '../config/environment';

function driverWhere(): string {
  return `Email = '${env.driver!.email.replace(/'/g, "''")}'`;
}

test.describe('Forgot password (QC-709)', () => {
  test.use(signedOut);
  test.skip(!canReadIdentityLog(), "Needs Identity's local log folder (IDENTITY_LOG_DIR): Development writes reset emails there when no mail server is set.");

  test('RESET-01 an unknown email gets the normal confirmation and no email is sent', async ({ page }) => {
    const email = `reset01-${Date.now()}@quarryconnect.test`;
    const mark = markIdentityLog();

    await new IdentityPasswordResetPage(page).requestReset(email);

    await expect.poll(() => identityLogSince(mark)).toContain(`unknown email ${email}`);
    expect(identityLogSince(mark)).not.toMatch(new RegExp(`${email.replace(/[.]/g, '\.')}.*was not sent`));
  });

  test('RESET-02 a fourth request for the same address within 15 minutes is throttled but looks the same', async ({ page }) => {
    const email = `reset02-${Date.now()}@quarryconnect.test`;
    const reset = new IdentityPasswordResetPage(page);
    const mark = markIdentityLog();

    for (let i = 0; i < 4; i++) {
      await reset.requestReset(email);
    }

    await expect.poll(() => identityLogSince(mark)).toContain(`too many requests for email ${email}`);
    expect(identityLogSince(mark).split(`too many requests for email ${email}`).length - 1).toBe(1);
  });

  test.describe('with the test driver', { tag: '@write' }, () => {
    test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD in env/<env>.secrets.env).');
    test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to change and restore the test driver.");

    test('RESET-03 a deactivated driver gets the normal confirmation and no email is sent', async ({ page }) => {
      const original = queryIdentityDb(`SELECT CAST(IsActive AS int) FROM Users WHERE ${driverWhere()}`);
      const mark = markIdentityLog();

      try {
        queryIdentityDb(`UPDATE Users SET IsActive = 0 WHERE ${driverWhere()}`);
        await new IdentityPasswordResetPage(page).requestReset(env.driver!.email);

        await expect.poll(() => identityLogSince(mark)).toMatch(/Password reset requested for deactivated user/);
        expect(identityLogSince(mark)).not.toContain('was not sent');
      } finally {
        queryIdentityDb(`UPDATE Users SET IsActive = ${Number(original)} WHERE ${driverWhere()}`);
      }
    });

    test('RESET-04 a reset link carries only ?t=, signs the account out everywhere, and the used or an altered link is refused before any form is shown', async ({ browser, page }) => {
      test.skip(!canSeedThrowawayUsers(), 'Needs ADMIN_EMAIL / ADMIN_PASSWORD, whose password the throwaway account copies.');
      const user = seedIdentityUser(`e2e.qc775.t.reset04.${Date.now()}@quarryconnect.test`, 'QC-775 Reset', false);
      const where = `Email = '${user.email}'`;
      const elsewhere = await browser.newContext({ ...signedOut, ignoreHTTPSErrors: env.ignoreHttpsErrors });
      const reset = new IdentityPasswordResetPage(page);

      try {
        const other = await elsewhere.newPage();
        await other.goto(`${env.identityUrl}/Account/Login`);
        await Promise.all([
          other.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/Account/Login')),
          new IdentityLoginPage(other).signIn(user),
        ]);
        const otherSession = new IdentityLogoutPage(other);
        await otherSession.expectSignedIn();

        const link = await reset.resetVia(user.email, 'Reset04-Temporary-Pass!');
        expect([...new URL(link).searchParams.keys()], 'the link names no email, return address or Identity token').toEqual(['t']);
        expect(link).not.toContain(encodeURIComponent(user.email));

        await otherSession.expectSignedOut();
        expect(
          Number(queryIdentityDb(`SELECT COUNT(*) FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectId WHERE u.${where} AND s.EndReason = 'password-reset' AND s.Ended > DATEADD(minute, -5, SYSUTCDATETIME())`)),
        ).toBeGreaterThan(0);

        await reset.expectInvalidLink(link);

        const altered = new URL(link);
        const token = altered.searchParams.get('t')!;
        altered.searchParams.set('t', `${token.slice(0, -6)}AAAAAA`);
        await reset.expectInvalidLink(altered.toString());
      } finally {
        await elsewhere.close();
        removeIdentityUsers(user.email);
      }
    });
  });

  test('RESET-05 a link older than 2 hours is refused', async () => {
    test.skip(true, 'The 2-hour link lifetime cannot be waited out in a test run. Since QC-775 the link is a row in PasswordResetLinks with its own Expires (PasswordResetDefaults.LinkLifetime), checked by Identity when the link is used.');
  });
});
