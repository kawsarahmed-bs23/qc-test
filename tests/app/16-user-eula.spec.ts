// QC-888: Admin > Users and Vendor > Users edit show the user's EULA status and let an administrator reset a rejected
// EULA. Local only: every user is an e2e.qc888.*@quarryconnect.test throwaway seeded by seed/host-qc888-user.apply.sql
// (and seed/identity-qc888-user.apply.sql for the users who sign in) and removed by host-qc888.remove.sql /
// identity-qc888.remove.sql, with their EULA signatures and the auth.AuditChanges rows a reset writes.
// Admin > Users runs as a throwaway host admin of organisation 30 (two-step on), not the shared app admin; Vendor > Users
// runs as a throwaway vendor of organisation 34 (TV), whose driver sits under TV's truck 38, because the local vendor
// login has no host user.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb } from '@utils/localDb';
import {
  AppUserSession,
  EULA_NOT_REJECTED_MESSAGE,
  EULA_REJECTED_SIGN_IN,
  EULA_RESET_MESSAGE,
  HOST_ORGANISATION_ID,
  VENDOR_ORGANISATION_ID,
  VENDOR_TRUCK_ORGANISATION_ID,
  appDateTime,
  eulaDbState,
  remainingQc888Rows,
  removeQc888Users,
  seedQc888User,
  type Qc888User,
} from '@pages/user-eula.page';

const REJECTED_ON = new Date(Date.UTC(2026, 9, 1, 15, 30, 0));
const ACCEPTED_ON = new Date(Date.UTC(2026, 9, 2, 19, 5, 0));
const DRIVER_REJECTED_ON = new Date(Date.UTC(2026, 9, 3, 4, 45, 0));
const DISPLAY_FORMAT = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}(AM|PM)$/;

function minutesBetween(from: Date, to: Date): RegExp {
  const shown = new Set<string>();
  for (let t = from.getTime() - 60_000; t <= to.getTime() + 60_000; t += 30_000) {
    shown.add(appDateTime(new Date(t)));
  }
  return new RegExp(`(${[...shown].map((s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})`);
}

test.describe('User Edit EULA status and reset (QC-888)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canSeedLocalDb() || !canUseIdentityDb() || !env.admin || !env.appApiUrl || !env.appTimeZone,
    "Needs the host's and Identity's local databases, ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway users, APP_API_URL and APP_TIME_ZONE.",
  );

  let admin: Qc888User;
  let rejected: Qc888User;
  let accepted: Qc888User;
  let pending: Qc888User;
  let vendor: Qc888User;
  let vendorDriver: Qc888User;
  let signer: Qc888User;
  let rejecter: Qc888User;
  let adminSession: AppUserSession;

  test.beforeAll(async ({ browser }) => {
    removeQc888Users();
    admin = seedQc888User({ name: 'admin', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'accepted', eulaOnUtc: ACCEPTED_ON, canSignIn: true });
    rejected = seedQc888User({ name: 'rejected', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'rejected', eulaOnUtc: REJECTED_ON });
    accepted = seedQc888User({ name: 'accepted', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'accepted', eulaOnUtc: ACCEPTED_ON });
    pending = seedQc888User({ name: 'pending', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'none' });
    vendor = seedQc888User({
      name: 'vendor',
      role: 'Vendor',
      organisationId: VENDOR_ORGANISATION_ID,
      eula: 'accepted',
      eulaOnUtc: ACCEPTED_ON,
      canSignIn: true,
    });
    vendorDriver = seedQc888User({
      name: 'vendor-driver',
      role: 'Driver',
      organisationId: VENDOR_TRUCK_ORGANISATION_ID,
      eula: 'rejected',
      eulaOnUtc: DRIVER_REJECTED_ON,
    });
    signer = seedQc888User({ name: 'signer', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'rejected', eulaOnUtc: REJECTED_ON, canSignIn: true });
    rejecter = seedQc888User({ name: 'rejecter', role: 'Admin', organisationId: HOST_ORGANISATION_ID, eula: 'none', canSignIn: true });

    adminSession = await AppUserSession.signIn(browser, admin.signIn!);
    await adminSession.expectSignedIn();
  });

  test.afterAll(async () => {
    await adminSession?.close();
    removeQc888Users();
    expect(remainingQc888Rows(), 'no e2e.qc888 host users or EULA signatures are left').toBe(0);
  });

  test('EULA-01 Admin > Users edit of a user who rejected the EULA shows "Rejected on <date>" in MM/dd/yyyy hh:mmtt and a Reset EULA button', async ({
    userEulaApi,
  }) => {
    const edit = adminSession.adminUserEdit;
    await edit.open(rejected.userId);
    await edit.eula.expectRejected(appDateTime(REJECTED_ON));

    await userEulaApi.useTokenOf(adminSession.page);
    const status = await userEulaApi.eulaStatus('manageusers', rejected.userId);
    expect(status).toEqual({ status: 'rejected', statusDate: appDateTime(REJECTED_ON), canReset: true });
    expect(status.statusDate).toMatch(DISPLAY_FORMAT);
  });

  test('EULA-02 Admin > Users edit of a user who signed the latest EULA shows "Accepted on <date>" and no Reset EULA button', async ({ userEulaApi }) => {
    const edit = adminSession.adminUserEdit;
    await edit.open(accepted.userId);
    await edit.eula.expectAccepted(appDateTime(ACCEPTED_ON));

    await userEulaApi.useTokenOf(adminSession.page);
    expect(await userEulaApi.eulaStatus('manageusers', accepted.userId)).toEqual({ status: 'accepted', statusDate: appDateTime(ACCEPTED_ON), canReset: false });
  });

  test('EULA-03 Admin > Users edit of a user with neither shows "Not yet accepted" and no button, and the create page shows no EULA row', async ({
    userEulaApi,
  }) => {
    const edit = adminSession.adminUserEdit;
    await edit.open(pending.userId);
    await edit.eula.expectNotYetAccepted();

    await userEulaApi.useTokenOf(adminSession.page);
    expect(await userEulaApi.eulaStatus('manageusers', pending.userId)).toEqual({ status: 'not-accepted', statusDate: null, canReset: false });

    await edit.open();
    await edit.eula.expectAbsent();
  });

  test('EULA-04 resetting a rejected EULA from Admin > Users confirms first, shows the API message, shows "Not yet accepted" and clears the flag with one audit row', async () => {
    expect(eulaDbState(rejected.userId)).toMatchObject({ rejected: true, audits: 0 });

    const edit = adminSession.adminUserEdit;
    await edit.open(rejected.userId);
    await edit.eula.startReset();
    await edit.eula.expectConfirmFor(rejected.email);
    await edit.eula.confirmReset();
    await edit.eula.expectSuccessToast(EULA_RESET_MESSAGE);
    await edit.eula.expectNotYetAccepted();

    expect(eulaDbState(rejected.userId)).toEqual({ rejected: false, rejectedOn: null, signatures: 0, audits: 1 });

    await edit.open(pending.userId);
    await edit.open(rejected.userId);
    await edit.eula.expectNotYetAccepted();
  });

  test('EULA-05 the reset endpoints answer 400 "User has not rejected the EULA." for a user who has not rejected it, 404 for an unknown user, and change nothing', async ({
    userEulaApi,
  }) => {
    await userEulaApi.useTokenOf(adminSession.page);
    const before = eulaDbState(pending.userId);

    const notRejected = await userEulaApi.resetEula('manageusers', pending.userId);
    expect(notRejected.status()).toBe(400);
    expect(JSON.stringify(await notRejected.json())).toContain(EULA_NOT_REJECTED_MESSAGE);

    const alreadyReset = await userEulaApi.resetEula('manageusers', rejected.userId);
    expect(alreadyReset.status()).toBe(400);
    expect(JSON.stringify(await alreadyReset.json())).toContain(EULA_NOT_REJECTED_MESSAGE);

    expect((await userEulaApi.resetEula('manageusers', 'e2e-qc888-no-such-user')).status()).toBe(404);

    expect(eulaDbState(pending.userId)).toEqual(before);
    expect(eulaDbState(rejected.userId).audits).toBe(1);
  });

  test("EULA-06 Vendor > Users edit of a driver under the vendor's truck shows the status and resets a rejected EULA", async ({ browser, userEulaApi }) => {
    const session = await AppUserSession.signIn(browser, vendor.signIn!);
    try {
      await session.expectSignedIn();
      const edit = session.vendorUserEdit;

      await edit.open(vendorDriver.userId);
      await edit.eula.expectRejected(appDateTime(DRIVER_REJECTED_ON));

      await userEulaApi.useTokenOf(session.page);
      expect(await userEulaApi.eulaStatus('vendor', vendorDriver.userId)).toEqual({
        status: 'rejected',
        statusDate: appDateTime(DRIVER_REJECTED_ON),
        canReset: true,
      });
      const notRejected = await userEulaApi.resetEula('vendor', vendor.userId);
      expect(notRejected.status()).toBe(400);
      expect(JSON.stringify(await notRejected.json())).toContain(EULA_NOT_REJECTED_MESSAGE);

      await edit.eula.startReset();
      await edit.eula.expectConfirmFor(vendorDriver.email);
      await edit.eula.confirmReset();
      await edit.eula.expectSuccessToast(EULA_RESET_MESSAGE);
      await edit.eula.expectNotYetAccepted();
      expect(eulaDbState(vendorDriver.userId)).toEqual({ rejected: false, rejectedOn: null, signatures: 0, audits: 1 });

      await edit.open();
      await edit.eula.expectAbsent();
    } finally {
      await session.close();
    }
  });

  test('EULA-07 a rejected user is refused at sign-in; after a reset they land on the agreement, accept it, and Admin > Users shows Accepted', async ({
    browser,
    userEulaApi,
  }) => {
    const refused = await AppUserSession.signIn(browser, signer.signIn!);
    try {
      await refused.expectRefused(EULA_REJECTED_SIGN_IN);
    } finally {
      await refused.close();
    }
    expect(eulaDbState(signer.userId)).toMatchObject({ rejected: true, signatures: 0 });

    await userEulaApi.useTokenOf(adminSession.page);
    const reset = await userEulaApi.resetEula('manageusers', signer.userId);
    expect(reset.status()).toBe(200);
    const body = await reset.json();
    expect(body.message).toBe(EULA_RESET_MESSAGE);
    expect(body.data).toMatchObject({ status: 'not-accepted', canReset: false });

    const started = new Date();
    const session = await AppUserSession.signIn(browser, signer.signIn!);
    try {
      await session.agreement.expectVisible();
      await session.agreement.acceptAgreement();
    } finally {
      await session.close();
    }
    const finished = new Date();

    expect(eulaDbState(signer.userId)).toMatchObject({ rejected: false, signatures: 1 });
    await adminSession.adminUserEdit.open(signer.userId);
    await adminSession.adminUserEdit.eula.expectAccepted(minutesBetween(started, finished));
  });

  test('EULA-08 rejecting the agreement at sign-in stamps RejectedEULAOn in UTC with one audit row, Admin > Users shows "Rejected on <that time>", and the user is signed out', async ({
    browser,
  }) => {
    expect(eulaDbState(rejecter.userId)).toEqual({ rejected: false, rejectedOn: null, signatures: 0, audits: 0 });

    const started = new Date();
    const session = await AppUserSession.signIn(browser, rejecter.signIn!);
    try {
      await session.agreement.expectVisible();
      await session.agreement.rejectAgreement();
      const finished = new Date();

      const state = eulaDbState(rejecter.userId);
      expect(state).toMatchObject({ rejected: true, signatures: 0, audits: 1 });
      const rejectedOn = new Date(`${state.rejectedOn!.replace(' ', 'T')}Z`);
      expect(rejectedOn.getTime(), 'RejectedEULAOn is the UTC time of the reject').toBeGreaterThanOrEqual(started.getTime() - 120_000);
      expect(rejectedOn.getTime(), 'RejectedEULAOn is the UTC time of the reject').toBeLessThanOrEqual(finished.getTime() + 120_000);

      const edit = adminSession.adminUserEdit;
      await edit.open(rejecter.userId);
      await edit.eula.expectRejected(appDateTime(rejectedOn));

      await session.expectSignedOutAfterReject();
    } finally {
      await session.close();
    }
  });
});
