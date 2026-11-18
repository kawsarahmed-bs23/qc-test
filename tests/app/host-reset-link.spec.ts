import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb } from '@utils/localDb';
import { HostPasswordApi, MailSink, passwordLinkIn, PasswordRequestPacer } from '@pages/host-password-link.page';
import { QC993_EMAIL, removeQc993Users, seedQc993User } from '@pages/session-idle.page';

test.describe('Host password links go through the hash route (QC-996)', { tag: ['@write', '@regression'] }, () => {
  test.use(signedOut);
  test.skip(!canSeedLocalDb() || !env.appAdmin || !env.appApiUrl || !env.appUrl, 'Needs the local host database, APP_ADMIN_*, APP_API_URL and APP_URL.');

  test.beforeAll(async () => {
    test.skip(!(await MailSink.isListening()), 'The local SMTP sink is not listening (node scripts/smtp-sink.mjs <SMTP_SINK_PORT>).');
    removeQc993Users();
    seedQc993User();
  });

  test.afterAll(() => {
    removeQc993Users();
  });

  test('PWLINK-01 the Forgot password email links to /#/authentication/reset-password and the link opens Set Your Password', async ({
    resetPasswordPage,
    page,
  }) => {
    const since = MailSink.mark();
    const api = await HostPasswordApi.open();
    try {
      await PasswordRequestPacer.waitForSlot();
      PasswordRequestPacer.note();
      const answer = await api.forgot(QC993_EMAIL, false);
      expect(answer.status).toBe(200);
    } finally {
      await api.close();
    }
    const mail = await MailSink.latestTo(QC993_EMAIL, since);

    const link = passwordLinkIn(mail);

    const url = new URL(link.raw);
    expect(url.pathname).toBe('/');
    expect(url.hash.startsWith('#/authentication/reset-password?')).toBe(true);
    expect(link.email).toBe(QC993_EMAIL);
    expect(link.code).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    await resetPasswordPage.open(link);

    await expect(resetPasswordPage.title).toHaveText('Set Your Password');
    await expect(page).toHaveURL(/#\/authentication\/reset-password\?/);
  });
});
