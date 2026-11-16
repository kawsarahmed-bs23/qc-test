// QC-933 (D64, D105, D106): a change one side makes to the other's copy of a Driver's details is a proposal the receiver approves
// or declines. This file is the Host side: saving a linked Driver or Vendor user (Manage Users and the Vendor Portal) holds
// name, phone and Text messages back and sends them to the Driver; a Driver's own truck number arrives in Dispatch Messages
// with Approve / Decline. The Driver side is tests/drivers/change-proposals.spec.ts.
// Local only, against a host API, Drivers API and databases with the QC-933 tables (app.ChangeProposals on both) and a Host
// that messages the Drivers API (Messaging). Throwaway data: seed/identity-qc933-user.apply.sql (two Identity drivers),
// seed/host-qc933.apply.sql (a vendor, two trucks, host-only admin and vendor users, two linked drivers, one unlinked driver)
// and seed/drivers-qc933.apply.sql (their DRIVERS accounts, links and a second throwaway host); the matching *.remove.sql
// files remove everything. The Driver App is not in the workspace, so the Driver answers through the Drivers API.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { isDriversApiReachable } from '@api/password-grant.api';
import { ChangeProposalsSession } from '@pages/change-proposals.page';
import {
  ADMIN_EMAIL,
  BASE,
  DIRECTION,
  KIND,
  STATUS,
  VENDOR_EMAIL,
  canRunWorld,
  digits,
  driversProposals,
  driversUser,
  driversValue,
  hostChangeMessages,
  hostValue,
  localHostUuid,
  hostProposals,
  hostSettingsPhone,
  hostToday,
  hostUser,
  removeWorld,
  resetWorld,
  restoreDriversMode,
  seedWorld,
  sqlText,
  truckNumberOf,
  waitForHostToSeeOrganisations,
  waitForQueues,
  type World,
} from '@utils/changeProposalsWorld';

const POLL = { timeout: 45_000, intervals: [500, 1_000, 2_000] };

test.describe('Change proposals, Host side: editing a linked Driver and answering a Driver proposal (QC-933)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.skip(
    !canRunWorld(),
    'Needs the host, DRIVERS and Identity local databases, ADMIN_* and DRIVER_* accounts, APP_API_URL, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
  );

  let world: World;
  let admin: ChangeProposalsSession;
  let vendor: ChangeProposalsSession;

  test.beforeAll(async ({ browser, playwright }) => {
    const hostUuid = localHostUuid();
    test.setTimeout(480_000);
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
      test.skip(
        !hostUuid || Number(driversValue(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`) ?? '0') === 0,
        'The host (EnvironmentSetting Messaging:HostUuid) is not an active host in DRIVERS.',
      );
      test.skip(
        driversValue(`SELECT CASE WHEN OBJECT_ID(N'app.ChangeProposals', N'U') IS NULL THEN 0 ELSE 1 END`) !== '1',
        'The DRIVERS database has no app.ChangeProposals (QC-933 migration).',
      );
      world = await seedWorld(request, hostUuid);
    } finally {
      await request.dispose();
    }
    admin = await ChangeProposalsSession.signIn(browser, { email: ADMIN_EMAIL, password: env.admin!.password });
    vendor = await ChangeProposalsSession.signIn(browser, { email: VENDOR_EMAIL, password: env.admin!.password });
    await waitForHostToSeeOrganisations(admin.api, world);
    await expect
      .poll(async () => (await vendor.api.userEdit('vendor', world.driver.hostUserId)).status, {
        message: 'the Vendor Portal sees the throwaway driver',
        ...POLL,
      })
      .toBe(200);
  });

  test.afterAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
      await admin?.close();
      await vendor?.close();
      if (world) await resetWorld(world);
    } finally {
      try {
        removeWorld();
      } finally {
        await restoreDriversMode(request, world);
        await request.dispose();
      }
    }
  });

  test.beforeEach(async () => {
    await resetWorld(world);
  });

  test('CHG-01 saving a linked Driver with a new name keeps the Host name, shows the pending note on Edit User, and puts a pending proposal in DRIVERS', async () => {
    const page = admin.adminUser;
    await page.open(world.driver.hostUserId);
    await page.firstName.fill('Changed');
    expect(await page.saveExisting()).toBe(200);

    expect(hostUser(world.driver.hostUserId), 'the Host name is not changed by the save').toMatchObject({
      firstName: BASE.firstName,
      lastName: BASE.driverLastName,
    });
    const [sent, ...others] = hostProposals(world.driver.hostUserId);
    expect(others, 'one proposal per save').toEqual([]);
    expect(sent).toMatchObject({
      kind: KIND.userDetails,
      direction: DIRECTION.sent,
      status: STATUS.pending,
      firstName: 'Changed',
      lastName: BASE.driverLastName,
      mobilePhone: null,
      notifyBySms: null,
    });

    await page.open(world.driver.hostUserId);
    await expect(page.firstName, 'the form still shows the Host value').toHaveValue(BASE.firstName);
    await expect(page.pendingChanges).toHaveText(['Waiting for the Driver to approve: name Changed QC-933 Driver.']);

    await expect.poll(() => driversProposals(world.driver.sub, world.hostUuid), { message: 'UserDetailsChanged reaches DRIVERS', ...POLL }).toHaveLength(1);
    const [received] = driversProposals(world.driver.sub, world.hostUuid);
    expect(received).toMatchObject({
      changeUuid: sent.changeUuid,
      kind: KIND.userDetails,
      direction: DIRECTION.received,
      status: STATUS.pending,
      firstName: 'Changed',
      lastName: BASE.driverLastName,
    });
    expect(driversUser(world.driver.sub), 'the Driver copy waits for approval').toMatchObject({ firstName: BASE.firstName, lastName: BASE.driverLastName });
  });

  test('CHG-04 a phone change from the Vendor Portal waits for the Driver: the Host phone stays, the Driver approves, and the Host phone follows once ChangeAnswered arrives', async ({
    driverChangesApi,
  }) => {
    const saved = await vendor.api.editUser('vendor', world.driver.hostUserId, { phoneNumber: '5125550934' });
    expect(saved.status, saved.text).toBe(200);

    expect(digits(hostUser(world.driver.hostUserId).phone), 'the Host phone is not changed by the save').toBe(BASE.driverHostPhone);
    const [sent] = hostProposals(world.driver.hostUserId);
    expect(sent).toMatchObject({
      kind: KIND.userDetails,
      direction: DIRECTION.sent,
      status: STATUS.pending,
      mobilePhone: '+15125550934',
      notifyBySms: null,
      firstName: BASE.firstName,
    });
    expect((await vendor.api.userEdit('vendor', world.driver.hostUserId)).data).toMatchObject({
      PendingChanges: ['Waiting for the Driver to approve: phone +15125550934.'],
    });

    await expect
      .poll(async () => (await driverChangesApi.list(world.driver.token)).body.data?.changes.length ?? 0, {
        message: 'the proposal reaches the Driver',
        ...POLL,
      })
      .toBe(1);
    const pending = (await driverChangesApi.list(world.driver.token)).body.data!.changes[0];
    expect(pending).toMatchObject({
      changeUuid: sent.changeUuid,
      kind: 'user-details',
      direction: 'received',
      status: 'pending',
      mobilePhone: '+15125550934',
      hostUuid: world.hostUuid,
    });
    expect(driversUser(world.driver.sub).phone, 'the Driver phone waits').toBe(BASE.driverE164);

    const answered = await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'approved');
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(driversUser(world.driver.sub).phone, 'approving changes the Driver phone').toBe('+15125550934');

    await expect.poll(() => hostProposals(world.driver.hostUserId)[0]?.status, { message: 'ChangeAnswered reaches the Host', ...POLL }).toBe(STATUS.approved);
    expect(digits(hostUser(world.driver.hostUserId).phone), 'the Host phone follows the approval').toBe('15125550934');
    expect(digits(hostSettingsPhone(world.driver.hostUserId))).toBe('15125550934');
    expect((await vendor.api.userEdit('vendor', world.driver.hostUserId)).data).toMatchObject({ PendingChanges: [] });
    await waitForQueues();
    expect(hostProposals(world.driver.hostUserId), 'nothing is sent back to the Driver').toHaveLength(1);
    expect(driversProposals(world.driver.sub, world.hostUuid), 'the Driver adds no proposal of its own').toHaveLength(1);
  });

  test('CHG-05 turning Text messages on for a linked Driver waits for the Driver, and a save with Text messages off sends nothing', async ({
    driverChangesApi,
  }) => {
    const page = admin.adminUser;
    await page.open(world.driver.hostUserId);
    await page.expectContactForDriverApproval();
    await expect(page.textMessages.checkbox).not.toBeChecked();
    await page.textMessages.checkbox.check();
    expect(await page.saveExisting()).toBe(200);

    expect(hostUser(world.driver.hostUserId).notifyBySms, 'the Host copy stays off until the Driver approves').toBe('0');
    const [sent] = hostProposals(world.driver.hostUserId);
    expect(sent).toMatchObject({
      kind: KIND.userDetails,
      direction: DIRECTION.sent,
      status: STATUS.pending,
      notifyBySms: '1',
      mobilePhone: null,
      firstName: BASE.firstName,
    });
    await page.open(world.driver.hostUserId);
    await expect(page.textMessages.checkbox).not.toBeChecked();
    await expect(page.pendingChanges).toHaveText(['Waiting for the Driver to approve: Text messages on.']);

    await expect.poll(async () => (await driverChangesApi.list(world.driver.token)).body.data?.changes.length ?? 0, { ...POLL }).toBe(1);
    const pending = (await driverChangesApi.list(world.driver.token)).body.data!.changes[0];
    expect(pending).toMatchObject({ kind: 'user-details', notifyBySms: true, mobilePhone: null });
    expect(driversUser(world.driver.sub).notifyBySms, 'the Driver setting waits').not.toBe('1');

    expect((await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'approved')).status).toBe(200);
    expect(driversUser(world.driver.sub).notifyBySms, 'approving turns Text messages on for the Driver').toBe('1');
    await expect.poll(() => hostUser(world.driver.hostUserId).notifyBySms, { message: 'the Host copy follows ChangeAnswered', ...POLL }).toBe('1');
    expect(hostProposals(world.driver.hostUserId)[0].status).toBe(STATUS.approved);
    await waitForQueues();

    const off = await admin.api.editUser('manageusers', world.driver.hostUserId, { notifyBySms: false });
    expect(off.status, off.text).toBe(200);
    expect(hostUser(world.driver.hostUserId).notifyBySms, 'Text messages off is not a change the Host can make for a linked Driver').toBe('1');
    expect(hostProposals(world.driver.hostUserId), 'and it is not sent').toHaveLength(1);
  });

  test('CHG-06 a save with nothing changed, and a save of an unlinked Driver, send no proposal', async () => {
    const unchanged = await admin.api.editUser('manageusers', world.driver.hostUserId);
    expect(unchanged.status, unchanged.text).toBe(200);
    const unchangedPortal = await vendor.api.editUser('vendor', world.driver.hostUserId);
    expect(unchangedPortal.status, unchangedPortal.text).toBe(200);
    expect(hostProposals(world.driver.hostUserId), 'nothing to propose').toEqual([]);

    const sameName = await admin.api.editUser('manageusers', world.driver.hostUserId, { firstName: `  ${BASE.firstName}  `, phoneNumber: '(512) 555-9331' });
    expect(sameName.status, sameName.text).toBe(200);
    expect(hostProposals(world.driver.hostUserId), 'the same name and the same phone written another way propose nothing').toEqual([]);

    try {
      const plain = await admin.api.editUser('manageusers', world.plainId, { firstName: 'PlainChanged', phoneNumber: '5125550939', notifyBySms: false });
      expect(plain.status, plain.text).toBe(200);
      expect(hostUser(world.plainId), 'an unlinked Driver is saved as before').toMatchObject({ firstName: 'PlainChanged', notifyBySms: '0' });
      expect(digits(hostUser(world.plainId).phone)).toBe('5125550939');
      expect(hostProposals(world.plainId), 'and proposes nothing').toEqual([]);
    } finally {
      restorePlainDriver(world.plainId);
    }
    expect(hostUser(world.plainId).firstName, 'the unlinked Driver is back').toBe(BASE.firstName);

    await waitForQueues();
    expect(driversProposals(world.driver.sub), 'nothing reached DRIVERS').toEqual([]);
  });

  test('CHG-09 a truck number the Driver edits reaches Dispatch Messages, and Approve in Comms updates the Truck and sends ChangeAnswered back', async ({
    driverChangesApi,
  }) => {
    const saved = await driverChangesApi.saveTruckNumber(world.driver.token, 'E2E933-D2');
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(driversUser(world.driver.sub).truckNumber, 'the Driver keeps the number it typed').toBe('E2E933-D2');
    const sentRows = driversProposals(world.driver.sub);
    expect(sentRows.map((row) => [row.kind, row.direction, row.status, row.other]).sort()).toEqual(
      [
        [KIND.driverTruckNumber, DIRECTION.sent, STATUS.pending, world.hostUuid],
        [KIND.driverTruckNumber, DIRECTION.sent, STATUS.pending, world.secondHostUuid],
      ].sort(),
    );

    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { message: 'DriverTruckNumberChanged reaches the Host', ...POLL }).toBe(1);
    const [received] = hostProposals(world.driver.hostUserId);
    expect(received).toMatchObject({
      kind: KIND.driverTruckNumber,
      direction: DIRECTION.received,
      status: STATUS.pending,
      truckNumber: 'E2E933-D2',
      previousTruckNumber: BASE.driverTruckNumber,
    });
    const [message] = hostChangeMessages(world.driver.hostUserId);
    expect(message.actioned).toBe(false);
    expect(message.body).toContain(`changed their truck number to E2E933-D2 (was ${BASE.driverTruckNumber})`);
    expect(received.other, 'the proposal points at its Dispatch message').toBe(String(message.messageId));

    const queue = await admin.api.queue(hostToday());
    expect(queue.status, queue.text).toBe(200);
    expect(queue.data?.find((item) => item.messageId === message.messageId)?.change).toMatchObject({
      kind: 'driver-truck-number',
      direction: 'received',
      status: 'pending',
      truckNumber: 'E2E933-D2',
      canAnswer: true,
    });

    await admin.comms.open(world.driver.hostUserId);
    await expect(admin.comms.approve.first()).toBeVisible({ timeout: 30_000 });
    await expect(admin.comms.decline.first()).toBeVisible();
    expect(await admin.comms.answer('approve')).toBe(200);
    await expect(admin.comms.approve, 'the buttons go once the change is answered').toHaveCount(0);
    await expect(admin.comms.decline).toHaveCount(0);
    const answeredThread = await admin.api.thread(world.driver.hostUserId, hostToday());
    expect(answeredThread.data?.messages.find((m) => m.messageId === message.messageId)?.change).toMatchObject({ status: 'approved', canAnswer: false });

    expect(truckNumberOf(world.truckA), 'Approve updates TruckSettings.TruckNumber').toBe('E2E933-D2');
    const [answered] = hostProposals(world.driver.hostUserId);
    expect(answered.status).toBe(STATUS.approved);
    test.info().annotations.push({ type: 'answeredByName', description: String(answered.answeredByName) });
    expect(hostChangeMessages(world.driver.hostUserId)[0].actioned, 'the message is actioned').toBe(true);

    await expect
      .poll(() => driversProposals(world.driver.sub, world.hostUuid)[0]?.status, { message: 'ChangeAnswered reaches DRIVERS', ...POLL })
      .toBe(STATUS.approved);
    expect(driversProposals(world.driver.sub, world.hostUuid)[0].answeredByName).toBe(answered.answeredByName);
    expect(driversProposals(world.driver.sub, world.secondHostUuid)[0].status, 'the other Host has not answered').toBe(STATUS.pending);
    expect(driversUser(world.driver.sub).truckNumber).toBe('E2E933-D2');
    await waitForQueues();
    expect(hostProposals(world.driver.hostUserId), 'approving sends no new proposal back to the Driver').toHaveLength(1);
  });

  test('CHG-10 Approve is refused when the number is taken in the Vendor or the Driver has no Truck, nothing changes, and Decline works with a comment', async ({
    driverChangesApi,
  }) => {
    const taken = await driverChangesApi.saveTruckNumber(world.driver.token, BASE.truckB);
    expect(taken.status, JSON.stringify(taken.body)).toBe(200);
    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { ...POLL }).toBe(1);
    const [duplicate] = hostChangeMessages(world.driver.hostUserId);

    const refusedDuplicate = await admin.api.answerChange(duplicate.messageId, 'approved');
    expect(refusedDuplicate.status, refusedDuplicate.text).toBe(400);
    expect(refusedDuplicate.text).toContain('already used by another Truck of this Vendor');
    expect(truckNumberOf(world.truckA), 'the Truck keeps its number').toBe(BASE.truckA);
    expect(truckNumberOf(world.truckB)).toBe(BASE.truckB);
    expect(hostProposals(world.driver.hostUserId)[0].status, 'the proposal still waits').toBe(STATUS.pending);
    expect(hostChangeMessages(world.driver.hostUserId)[0].actioned).toBe(false);

    const declined = await admin.api.answerChange(duplicate.messageId, 'declined', 'That number is Truck B');
    expect(declined.status, declined.text).toBe(200);
    expect(hostProposals(world.driver.hostUserId)[0]).toMatchObject({ status: STATUS.declined, answerComment: 'That number is Truck B' });
    expect(truckNumberOf(world.truckA)).toBe(BASE.truckA);
    await expect
      .poll(() => driversProposals(world.driver.sub, world.hostUuid)[0]?.answerComment, { message: 'the decline reaches DRIVERS with its comment', ...POLL })
      .toBe('That number is Truck B');
    expect(driversProposals(world.driver.sub, world.hostUuid)[0].status).toBe(STATUS.declined);
    expect(driversUser(world.driver.sub).truckNumber, 'a decline does not change the Driver number').toBe(BASE.truckB);

    const noTruck = await driverChangesApi.saveTruckNumber(world.driver2.token, 'E2E933-X');
    expect(noTruck.status, JSON.stringify(noTruck.body)).toBe(200);
    await expect.poll(() => hostProposals(world.driver2.hostUserId).length, { ...POLL }).toBe(1);
    const [orphan] = hostChangeMessages(world.driver2.hostUserId);

    const refusedNoTruck = await admin.api.answerChange(orphan.messageId, 'approved');
    expect(refusedNoTruck.status, refusedNoTruck.text).toBe(400);
    expect(refusedNoTruck.text).toContain('not on a Truck');
    expect(hostProposals(world.driver2.hostUserId)[0].status).toBe(STATUS.pending);
    expect(Number(hostValue(`SELECT COUNT(*) FROM app.TruckSettings WHERE TruckNumber = ${sqlText('E2E933-X')}`)), 'no Truck got the number').toBe(0);

    await admin.comms.open(world.driver2.hostUserId);
    await expect(admin.comms.decline.first()).toBeVisible({ timeout: 30_000 });
    expect(await admin.comms.answer('decline')).toBe(200);
    await expect(admin.comms.decline).toHaveCount(0);
    const declinedThread = await admin.api.thread(world.driver2.hostUserId, hostToday());
    expect(declinedThread.data?.messages.find((m) => m.messageId === orphan.messageId)?.change).toMatchObject({ status: 'declined', canAnswer: false });
    expect(hostProposals(world.driver2.hostUserId)[0].status).toBe(STATUS.declined);
    await expect.poll(() => driversProposals(world.driver2.sub)[0]?.status, { message: 'the decline reaches DRIVERS', ...POLL }).toBe(STATUS.declined);
    expect(driversUser(world.driver2.sub).truckNumber).toBe('E2E933-X');
  });
});

function restorePlainDriver(plainId: string): void {
  hostValue(
    `UPDATE auth.Users SET FirstName = N'${BASE.firstName}', PhoneNumber = N'5125559333' WHERE Id = N'${plainId}'; DELETE app.UserSettings WHERE UserID_FK = N'${plainId}'`,
  );
}
