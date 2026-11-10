import type { Page } from '@playwright/test';
import { env } from '@config/env.config';
import { test, expect, signedOut } from '@fixtures/pageFixtures';
import {
  canSeedThrowawayUsers,
  clearQc876Lockout,
  countQc876Users,
  qc876LockoutState,
  removeQc876Users,
  seedQc876User,
  type ThrowawayUser,
} from '@utils/throwawayUsers';
import { currentStep, totp } from '@utils/totp';
import { IdentityLoginPage, IdentityLogoutPage, IdentityTwoStepPage } from '@pages/identity-login.page';

const INVALID = 'Invalid email or password';
const LOCKED = 'Your account is locked for 15 minutes after 5 failed sign-in attempts. Try again later or contact your administrator.';
const DEACTIVATED = 'Your account is deactivated. Contact your administrator.';
const INVALID_CODE = 'The code is not valid. Try again.';
const INVALID_ES = 'Correo electrónico o contraseña no válidos';
const LOCKED_ES =
  'Su cuenta está bloqueada durante 15 minutos tras 5 intentos fallidos de inicio de sesión. Inténtelo más tarde o contacte con su administrador.';
const LOCKOUT_THRESHOLD = 5;

function email(name: string): string {
  return `e2e.qc876.${name}@quarryconnect.test`;
}

function wrongPassword(user: ThrowawayUser): ThrowawayUser {
  return { ...user, password: `${user.password}-e2e-qc876-wrong` };
}

function wrongCode(key: string): string {
  const step = currentStep();
  const valid = new Set([-1, 0, 1, 2].map((offset) => totp(key, (step + offset) * 30_000)));
  return ['000000', '111111', '222222', '333333', '444444'].find((code) => !valid.has(code))!;
}

async function failPasswordUntilLocked(login: IdentityLoginPage, user: ThrowawayUser, invalid = INVALID, locked = LOCKED): Promise<void> {
  for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
    await login.submitOnce(wrongPassword(user));
    await expect(login.error, `wrong password ${attempt}`).toHaveText(invalid);
    expect(qc876LockoutState(user)).toEqual({ accessFailedCount: attempt, lockedOut: false });
  }
  await login.submitOnce(wrongPassword(user));
  await expect(login.error, `wrong password ${LOCKOUT_THRESHOLD}`).toHaveText(locked);
  expect(qc876LockoutState(user).lockedOut, 'LockoutEnd is in the future').toBe(true);
}

async function useSpanish(page: Page): Promise<void> {
  await page.context().addCookies([{ name: '.AspNetCore.Culture', value: encodeURIComponent('c=es|uic=es'), url: env.identityUrl }]);
}

test.describe('Sign-in lockout and deactivated accounts say so (QC-876)', { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);

  test.beforeAll(() => {
    if (canSeedThrowawayUsers()) removeQc876Users();
  });

  test.afterAll(() => {
    if (!canSeedThrowawayUsers()) return;
    removeQc876Users();
    expect(countQc876Users(), 'no e2e.qc876.* users left').toBe(0);
  });

  test.beforeEach(() => {
    test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database for throwaway e2e.qc876.* users.");
  });

  test('LOCK-01 four wrong passwords say "Invalid email or password"; the fifth locks the account and says so', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock01'), 'QC-876 Lock 01');
    const login = new IdentityLoginPage(page);
    await login.open();
    await failPasswordUntilLocked(login, user);
  });

  test('LOCK-02 while locked, the right password still shows the lock message and does not sign in', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock02'), 'QC-876 Lock 02');
    const login = new IdentityLoginPage(page);
    await login.open();
    await failPasswordUntilLocked(login, user);

    await login.submitOnce(user);
    await expect(login.error).toHaveText(LOCKED);
    await expect(page).toHaveURL(/\/Account\/Login/i);
    expect(qc876LockoutState(user).lockedOut).toBe(true);
    await new IdentityLogoutPage(page).expectSignedOut();
  });

  test('LOCK-03 once the lockout is cleared, the right password signs in', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock03'), 'QC-876 Lock 03');
    const login = new IdentityLoginPage(page);
    await login.open();
    await failPasswordUntilLocked(login, user);

    clearQc876Lockout(user);
    expect(qc876LockoutState(user)).toEqual({ accessFailedCount: 0, lockedOut: false });

    await login.open('/Account/Logout');
    await login.submitOnce(user);
    await expect(page).toHaveURL(/\/Account\/Logout/i);
    await expect(login.error).toHaveCount(0);
    await new IdentityLogoutPage(page).expectSignedIn();
  });

  test('LOCK-04 a deactivated account with a wrong password gets the generic message and no failed attempt is counted', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock04'), 'QC-876 Lock 04', { active: false });
    const login = new IdentityLoginPage(page);
    await login.open();
    await login.submitOnce(wrongPassword(user));
    await expect(login.error).toHaveText(INVALID);
    expect(qc876LockoutState(user)).toEqual({ accessFailedCount: 0, lockedOut: false });
  });

  test(
    'LOCK-05 a deactivated account with the right password is told it is deactivated, and the failed count does not move',
    { tag: '@write' },
    async ({ page }) => {
      const user = seedQc876User(email('lock05'), 'QC-876 Lock 05', { active: false });
      const login = new IdentityLoginPage(page);
      await login.open();
      for (let attempt = 1; attempt <= LOCKOUT_THRESHOLD + 1; attempt++) {
        await login.submitOnce(user);
        await expect(login.error, `right password ${attempt}`).toHaveText(DEACTIVATED);
      }
      expect(qc876LockoutState(user)).toEqual({ accessFailedCount: 0, lockedOut: false });
      await new IdentityLogoutPage(page).expectSignedOut();
    },
  );

  test('LOCK-06 five wrong two-step codes after the right password lock the account and the last one says so', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock06'), 'QC-876 Lock 06', { twoFactor: true });
    const login = new IdentityLoginPage(page);
    const twoStep = new IdentityTwoStepPage(page);
    await login.open();
    await login.signIn(user);
    await twoStep.expectVisible();
    expect(qc876LockoutState(user).accessFailedCount, 'the right password counts nothing').toBe(0);

    for (let attempt = 1; attempt < LOCKOUT_THRESHOLD; attempt++) {
      await twoStep.submitCode(wrongCode(user.authenticatorKey!));
      await expect(twoStep.error, `wrong code ${attempt}`).toHaveText(INVALID_CODE);
      expect(qc876LockoutState(user)).toEqual({ accessFailedCount: attempt, lockedOut: false });
    }
    await twoStep.submitCode(wrongCode(user.authenticatorKey!));
    await expect(twoStep.error, `wrong code ${LOCKOUT_THRESHOLD}`).toHaveText(LOCKED);
    expect(qc876LockoutState(user).lockedOut, 'LockoutEnd is in the future').toBe(true);
  });

  test('LOCK-07 with the Spanish culture cookie the generic and lock messages are in Spanish', { tag: '@write' }, async ({ page }) => {
    const user = seedQc876User(email('lock07'), 'QC-876 Lock 07');
    await useSpanish(page);
    const login = new IdentityLoginPage(page);
    await login.open();
    await failPasswordUntilLocked(login, user, INVALID_ES, LOCKED_ES);
  });
});
