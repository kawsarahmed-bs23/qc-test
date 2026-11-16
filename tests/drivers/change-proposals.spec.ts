// QC-933 (D64, D93, D105, D106): the Driver side of change proposals. A name, phone, Text messages or truck number change a
// Host proposes reaches DRIVERS as a pending proposal the Driver approves or declines through GET /me/change-proposals and
// POST /me/change-proposals/{changeUuid}/answer (the Driver App is not in the workspace, so these calls stand in for it).
// Approving applies the value to the Driver's own copy and sends ChangeAnswered back to the proposing Host only; a truck
// number approval also tells the Driver's other Hosts. The Host side is tests/app/change-proposals.spec.ts, and the two
// files share their throwaway data (seed/*-qc933.*.sql) and helpers (@utils/changeProposalsWorld).
// Local only, against a host API, Drivers API and databases with the QC-933 tables, a Host that messages the Drivers API, and
// a throwaway second host in DRIVERS whose message endpoint (tcp://localhost:6299) nothing listens on, so the messages sent to
// it wait in the Wolverine outbox of DRIVERS where the cases can see them.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { isDriversApiReachable } from '@api/password-grant.api';
import { ChangeProposalsApi, type DriverChangesApi } from '@api/change-proposals.api';
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
  hostProposals,
  hostUser,
  hostValue,
  localHostUuid,
  removeWorld,
  replayHandledEnvelope,
  resetWorld,
  restoreDriversMode,
  seedWorld,
  truckNumberOf,
  waitForHostToSeeOrganisations,
  waitForQueues,
  type World,
} from '@utils/changeProposalsWorld';

const POLL = { timeout: 45_000, intervals: [500, 1_000, 2_000] };

test.describe('Change proposals, Driver side: approving, declining and the rules between Hosts (QC-933)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 150_000 });
  test.skip(
    !canRunWorld(),
    'Needs the host, DRIVERS and Identity local databases, ADMIN_* and DRIVER_* accounts, APP_API_URL, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
  );

  let world: World;

  async function signedIn(api: ChangeProposalsApi, email = ADMIN_EMAIL): Promise<ChangeProposalsApi> {
    await api.signIn(email, env.admin!.password);
    return api;
  }

  async function pendingFor(driverChanges: DriverChangesApi, token: string, count: number) {
    await expect
      .poll(async () => (await driverChanges.list(token)).body.data?.changes.length ?? 0, { message: `${count} pending proposal(s) reach the Driver`, ...POLL })
      .toBe(count);
    return (await driverChanges.list(token)).body.data!.changes;
  }

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(480_000);
    const hostUuid = localHostUuid();
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
      const admin = await signedIn(new ChangeProposalsApi(request));
      await waitForHostToSeeOrganisations(admin, world);
      const vendor = await signedIn(new ChangeProposalsApi(request), VENDOR_EMAIL);
      await expect
        .poll(async () => (await vendor.userEdit('vendor', world.driver.hostUserId)).status, {
          message: 'the Vendor Portal sees the throwaway driver',
          ...POLL,
        })
        .toBe(200);
    } finally {
      await request.dispose();
    }
  });

  test.afterAll(async ({ playwright }) => {
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    try {
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

  test('CHG-02 the Driver approves a Host name change: DRIVERS applies it, the Host applies it once ChangeAnswered arrives, and nothing is sent back', async ({
    changeProposalsApi,
    driverChangesApi,
  }) => {
    const admin = await signedIn(changeProposalsApi);
    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'Approved' })).status).toBe(200);

    const [pending] = await pendingFor(driverChangesApi, world.driver.token, 1);
    expect(pending).toMatchObject({
      kind: 'user-details',
      direction: 'received',
      status: 'pending',
      firstName: 'Approved',
      lastName: BASE.driverLastName,
      hostUuid: world.hostUuid,
    });
    expect(driversUser(world.driver.sub).firstName, 'nothing is applied on arrival').toBe(BASE.firstName);
    expect(hostUser(world.driver.hostUserId).firstName).toBe(BASE.firstName);

    const answered = await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'approved');
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.data).toMatchObject({ status: 'approved', changeUuid: pending.changeUuid });
    expect(driversUser(world.driver.sub), 'the Driver copy changes on approval').toMatchObject({ firstName: 'Approved', lastName: BASE.driverLastName });

    await expect.poll(() => hostProposals(world.driver.hostUserId)[0]?.status, { message: 'ChangeAnswered reaches the Host', ...POLL }).toBe(STATUS.approved);
    expect(hostUser(world.driver.hostUserId), 'the Host copy follows the approval').toMatchObject({ firstName: 'Approved', lastName: BASE.driverLastName });
    expect((await driverChangesApi.list(world.driver.token, 'pending')).body.data?.changes).toEqual([]);
    expect((await driverChangesApi.list(world.driver.token, 'all')).body.data?.changes[0]).toMatchObject({ status: 'approved', direction: 'received' });

    await waitForQueues();
    expect(hostProposals(world.driver.hostUserId), 'the Host adds no proposal').toHaveLength(1);
    expect(driversProposals(world.driver.sub), 'the Driver adds no proposal for the change it just approved').toHaveLength(1);
    expect(driversProposals(world.driver.sub, world.secondHostUuid), "a name is not told to the Driver's other Hosts").toEqual([]);
  });

  test('CHG-03 the Driver declines a Host name change with a comment: nothing changes on either side and the Host shows Declined with the comment', async ({
    changeProposalsApi,
    driverChangesApi,
  }) => {
    const admin = await signedIn(changeProposalsApi);
    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'Declined' })).status).toBe(200);
    const [pending] = await pendingFor(driverChangesApi, world.driver.token, 1);

    const answered = await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'declined', 'That is not how my name is spelled');
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(answered.body.data).toMatchObject({ status: 'declined', answerComment: 'That is not how my name is spelled' });
    expect(driversUser(world.driver.sub).firstName, 'a decline changes nothing for the Driver').toBe(BASE.firstName);

    await expect.poll(() => hostProposals(world.driver.hostUserId)[0]?.status, { message: 'ChangeAnswered reaches the Host', ...POLL }).toBe(STATUS.declined);
    expect(hostProposals(world.driver.hostUserId)[0]).toMatchObject({ answerComment: 'That is not how my name is spelled', firstName: 'Declined' });
    expect(hostProposals(world.driver.hostUserId)[0].answeredByName, 'the Driver names itself in the answer').toContain('E2E');
    expect(hostUser(world.driver.hostUserId).firstName, 'a decline changes nothing for the Host').toBe(BASE.firstName);
    expect((await admin.userEdit('manageusers', world.driver.hostUserId)).data).toMatchObject({ firstName: BASE.firstName, PendingChanges: [] });
    await waitForQueues();
    expect(driversProposals(world.driver.sub)).toHaveLength(1);
  });

  test('CHG-07 a Host truck number change saves the Truck at once, reaches the Driver as a proposal, and the Driver approving sets its own truck number', async ({
    changeProposalsApi,
    driverChangesApi,
    request,
  }) => {
    const admin = await signedIn(changeProposalsApi);
    const saved = await admin.editTruckNumber('organisation', world.truckA, 'E2E933-A2');
    expect(saved.status, saved.text.slice(-500)).toBe(200);
    expect(truckNumberOf(world.truckA), 'the Host saves its Truck without waiting').toBe('E2E933-A2');

    const [sent] = hostProposals(world.driver.hostUserId);
    expect(sent).toMatchObject({
      kind: KIND.hostTruckNumber,
      direction: DIRECTION.sent,
      status: STATUS.pending,
      truckNumber: 'E2E933-A2',
      previousTruckNumber: BASE.truckA,
    });
    expect(hostProposals(world.driver2.hostUserId), 'the driver on no Truck is not told').toEqual([]);
    expect(hostProposals(world.plainId), 'an unlinked driver on another Truck is not told').toEqual([]);

    const [pending] = await pendingFor(driverChangesApi, world.driver.token, 1);
    expect(pending).toMatchObject({
      changeUuid: sent.changeUuid,
      kind: 'truck-number',
      direction: 'received',
      status: 'pending',
      truckNumber: 'E2E933-A2',
      previousTruckNumber: BASE.truckA,
      hostUuid: world.hostUuid,
    });
    expect(driversUser(world.driver.sub).truckNumber, 'the Driver number waits').toBe(BASE.driverTruckNumber);

    const answered = await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'approved');
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    expect(driversUser(world.driver.sub).truckNumber, 'approving sets DriverSettings.TruckNumber').toBe('E2E933-A2');
    expect((await driverChangesApi.settings(world.driver.token)).body.data?.TruckNumber).toBe('E2E933-A2');
    await expect.poll(() => hostProposals(world.driver.hostUserId)[0]?.status, { message: 'ChangeAnswered reaches the Host', ...POLL }).toBe(STATUS.approved);

    await waitForQueues();
    const vendorApi = await signedIn(new ChangeProposalsApi(request), VENDOR_EMAIL);
    const portalSaved = await vendorApi.editTruckNumber('vendor', world.truckA, 'E2E933-A3');
    expect(portalSaved.status, portalSaved.text).toBe(200);
    expect(truckNumberOf(world.truckA), 'the Vendor Portal copy saves the Truck too').toBe('E2E933-A3');
    const [portalPending] = await pendingFor(driverChangesApi, world.driver.token, 1);
    expect(portalPending).toMatchObject({ kind: 'truck-number', truckNumber: 'E2E933-A3', previousTruckNumber: 'E2E933-A2' });
    expect((await driverChangesApi.answer(world.driver.token, portalPending.changeUuid, 'declined')).status).toBe(200);
    expect(driversUser(world.driver.sub).truckNumber, 'a decline leaves the Driver number').toBe('E2E933-A2');
  });

  test("CHG-08 approving a Host truck number change tells the Driver's other Host, never the Host that proposed it, and a decline tells nobody", async ({
    changeProposalsApi,
    driverChangesApi,
  }) => {
    const admin = await signedIn(changeProposalsApi);
    expect((await admin.editTruckNumber('organisation', world.truckA, 'E2E933-A2')).status).toBe(200);
    const [declined] = await pendingFor(driverChangesApi, world.driver.token, 1);
    expect((await driverChangesApi.answer(world.driver.token, declined.changeUuid, 'declined')).status).toBe(200);
    await waitForQueues();
    expect(driversProposals(world.driver.sub, world.secondHostUuid), 'a decline tells no other Host').toEqual([]);

    expect((await admin.editTruckNumber('organisation', world.truckA, 'E2E933-A4')).status).toBe(200);
    const [pending] = await pendingFor(driverChangesApi, world.driver.token, 1);
    expect((await driverChangesApi.answer(world.driver.token, pending.changeUuid, 'approved')).status).toBe(200);

    const other = driversProposals(world.driver.sub, world.secondHostUuid);
    expect(other, 'the other Host gets one proposal for the new number').toHaveLength(1);
    expect(other[0]).toMatchObject({ kind: KIND.driverTruckNumber, direction: DIRECTION.sent, status: STATUS.pending, truckNumber: 'E2E933-A4' });
    test.info().annotations.push({ type: 'previousTruckNumberSentToOtherHost', description: String(other[0].previousTruckNumber) });
    expect(
      driversProposals(world.driver.sub, world.hostUuid).filter((row) => row.kind === KIND.driverTruckNumber),
      'nothing is proposed back to the Host that proposed it',
    ).toEqual([]);

    await expect.poll(() => hostProposals(world.driver.hostUserId).find((row) => row.truckNumber === 'E2E933-A4')?.status, { ...POLL }).toBe(STATUS.approved);
    await waitForQueues();
    expect(
      hostProposals(world.driver.hostUserId).filter((row) => row.direction === DIRECTION.received),
      'the proposing Host receives no DriverTruckNumberChanged back',
    ).toEqual([]);
    expect(hostChangeMessages(world.driver.hostUserId), 'and no Dispatch message').toEqual([]);
  });

  test('CHG-11 an older ChangedAt is stored as replaced and never offered, and a proposal delivered twice is stored once', async ({
    changeProposalsApi,
    driverChangesApi,
  }) => {
    const admin = await signedIn(changeProposalsApi);

    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'First' })).status).toBe(200);
    const [first] = await pendingFor(driverChangesApi, world.driver.token, 1);
    driversValue(`UPDATE app.ChangeProposals SET ChangedAt = DATEADD(HOUR, 1, ChangedAt) WHERE ChangeUUID = '${first.changeUuid}'`);
    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'Second' })).status).toBe(200);
    await expect.poll(() => driversProposals(world.driver.sub, world.hostUuid).length, { message: 'the second proposal reaches DRIVERS', ...POLL }).toBe(2);

    const rows = driversProposals(world.driver.sub, world.hostUuid);
    const stored = (name: string) => rows.find((row) => row.firstName === name);
    expect(stored('First'), 'the proposal with the later ChangedAt stays pending').toMatchObject({ status: STATUS.pending });
    expect(stored('Second'), 'the one with the older ChangedAt is stored as replaced').toMatchObject({ status: STATUS.superseded });
    expect((await driverChangesApi.list(world.driver.token)).body.data?.changes.map((change) => change.firstName)).toEqual(['First']);
    const replaced = await driverChangesApi.answer(world.driver.token, stored('Second')!.changeUuid, 'approved');
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(409);
    expect(driversUser(world.driver.sub).firstName, 'answering the replaced one changes nothing').toBe(BASE.firstName);

    await waitForQueues();
    const replayedName = replayHandledEnvelope('drivers', 'user-details-changed', first.changeUuid);
    test.skip(!replayedName, 'The Wolverine inbox no longer keeps the handled envelope to replay.');
    await expect
      .poll(() => replayHandledEnvelope('drivers', 'user-details-changed', first.changeUuid, true), {
        message: 'Wolverine runs the replayed envelope again',
        ...POLL,
      })
      .toBe('Handled');
    expect(driversProposals(world.driver.sub, world.hostUuid), 'the same ChangeUUID is stored once and nothing else is added').toHaveLength(2);

    await resetWorld(world);

    const sent = await driverChangesApi.saveTruckNumber(world.driver.token, 'E2E933-D2');
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { message: 'the first number reaches the Host', ...POLL }).toBe(1);
    const [arrived] = hostProposals(world.driver.hostUserId);
    hostValue(`UPDATE app.ChangeProposals SET ChangedAt = DATEADD(HOUR, 1, ChangedAt) WHERE ChangeUUID = '${arrived.changeUuid}'`);
    expect((await driverChangesApi.saveTruckNumber(world.driver.token, 'E2E933-D3')).status).toBe(200);
    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { message: 'the second number reaches the Host', ...POLL }).toBe(2);
    const hostRows = hostProposals(world.driver.hostUserId);
    expect(
      hostRows.find((row) => row.truckNumber === 'E2E933-D2'),
      'the later ChangedAt stays pending',
    ).toMatchObject({ status: STATUS.pending });
    expect(
      hostRows.find((row) => row.truckNumber === 'E2E933-D3'),
      'the older ChangedAt is stored as replaced',
    ).toMatchObject({ status: STATUS.superseded });
    expect(hostChangeMessages(world.driver.hostUserId), 'and it makes no Dispatch message').toHaveLength(1);
    expect(truckNumberOf(world.truckA)).toBe(BASE.truckA);

    await waitForQueues();
    const replayedNumber = replayHandledEnvelope('host', 'driver-truck-number-changed', arrived.changeUuid);
    test.skip(!replayedNumber, 'The Wolverine inbox no longer keeps the handled envelope to replay.');
    await expect
      .poll(() => replayHandledEnvelope('host', 'driver-truck-number-changed', arrived.changeUuid, true), {
        message: 'Wolverine runs the replayed envelope again',
        ...POLL,
      })
      .toBe('Handled');
    expect(hostProposals(world.driver.hostUserId), 'the same ChangeUUID is stored once and nothing else is added').toHaveLength(2);
    expect(hostChangeMessages(world.driver.hostUserId), 'and it makes no second Dispatch message').toHaveLength(1);
  });

  test('CHG-12 a newer proposal replaces the older pending one on both sides, and the replaced one can no longer be answered', async ({
    changeProposalsApi,
    driverChangesApi,
  }) => {
    const admin = await signedIn(changeProposalsApi);
    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'Older' })).status).toBe(200);
    await expect.poll(() => driversProposals(world.driver.sub, world.hostUuid).length, { ...POLL }).toBe(1);
    expect((await admin.editUser('manageusers', world.driver.hostUserId, { firstName: 'Newer' })).status).toBe(200);
    await expect.poll(() => driversProposals(world.driver.sub, world.hostUuid).length, { message: 'the newer proposal reaches DRIVERS', ...POLL }).toBe(2);

    const hostRows = hostProposals(world.driver.hostUserId);
    expect(hostRows.map((row) => [row.firstName, row.status])).toEqual([
      ['Older', STATUS.superseded],
      ['Newer', STATUS.pending],
    ]);
    const driverRows = driversProposals(world.driver.sub, world.hostUuid);
    expect(driverRows.map((row) => [row.firstName, row.status])).toEqual([
      ['Older', STATUS.superseded],
      ['Newer', STATUS.pending],
    ]);
    const offered = (await driverChangesApi.list(world.driver.token)).body.data!.changes;
    expect(
      offered.map((change) => change.firstName),
      'only the newer one is offered',
    ).toEqual(['Newer']);
    expect((await admin.userEdit('manageusers', world.driver.hostUserId)).data).toMatchObject({
      PendingChanges: ['Waiting for the Driver to approve: name Newer QC-933 Driver.'],
    });

    const replaced = await driverChangesApi.answer(world.driver.token, driverRows[0].changeUuid, 'approved');
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(409);
    expect(replaced.body.errors?.join(' ')).toContain('A newer change replaced this one');
    expect(driversUser(world.driver.sub).firstName).toBe(BASE.firstName);

    expect((await driverChangesApi.answer(world.driver.token, offered[0].changeUuid, 'approved')).status).toBe(200);
    expect(driversUser(world.driver.sub).firstName).toBe('Newer');
    await expect.poll(() => hostUser(world.driver.hostUserId).firstName, { message: 'the Host applies the newer name', ...POLL }).toBe('Newer');
    expect(hostProposals(world.driver.hostUserId).map((row) => row.status)).toEqual([STATUS.superseded, STATUS.approved]);

    await waitForQueues();
    await resetWorld(world);

    expect((await driverChangesApi.saveTruckNumber(world.driver.token, 'E2E933-D2')).status).toBe(200);
    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { ...POLL }).toBe(1);
    expect((await driverChangesApi.saveTruckNumber(world.driver.token, 'E2E933-D3')).status).toBe(200);
    await expect.poll(() => hostProposals(world.driver.hostUserId).length, { message: 'the newer number reaches the Host', ...POLL }).toBe(2);
    const truckRows = hostProposals(world.driver.hostUserId);
    expect(truckRows.map((row) => [row.truckNumber, row.status])).toEqual([
      ['E2E933-D2', STATUS.superseded],
      ['E2E933-D3', STATUS.pending],
    ]);
    const messages = hostChangeMessages(world.driver.hostUserId);
    expect(
      messages.map((message) => message.actioned),
      'the replaced one is closed in Dispatch Messages, the newer one waits',
    ).toEqual([true, false]);
    const queue = await admin.queue(new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date()));
    expect(queue.data?.filter((item) => item.change?.kind === 'driver-truck-number').map((item) => item.change?.truckNumber)).toEqual(['E2E933-D3']);
    expect(digits(hostUser(world.driver.hostUserId).phone)).toBe(BASE.driverHostPhone);
  });
});
