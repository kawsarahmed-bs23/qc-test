// QC-988: the Driver App's Terms of Use and Privacy Policy in the Host's table shape. DRIVERS keeps auth.UserEULADocs (one
// row per version, the live row only refers to the website) and auth.UserSignedEULAs (UserId is the person's UserUUID as
// lower-case text, no agreement text for Version 2). The drivers API answers GET /terms and POST /terms/accept; /eula is gone.
// Local only. API level as DRIVER_EMAIL against DRIVERS_API_URL; the driver must have no acceptance before the run, and every
// row a case adds is removed again. The Host-to-DRIVERS events (DriverInviteAccepted with TermsVersion) need a Host that sends
// them and a way to read the outbound LinkEstablished, which no helper offers; those cases are fixme with the reason.
// DTERMS-11 waits for the purge, so run the drivers API with AccountDeletion__PurgeIntervalMinutes=1 (as DEL-08 needs).
import { test, expect } from '@fixtures/pageFixtures';
import * as fs from 'fs';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseDriversDb, canUseIdentityDb, queryDriversDb, querySingleValue, runDriversSeedScript } from '@utils/localDb';
import { HostDriversMode, type DriversMode } from '@api/sms-routing.api';
import { DflowData, DflowHostAdminApi, dflowEmail, driversIsMigrated, removeDflowData, seedDflowWorld, waitForQueues } from '@api/driver-flows.api';
import { activeInviteKeyCount } from '@api/invite-readiness.api';
import { HostUserInvitesApi, Qc913Data, identityAcceptsLink, inviteEmailTo } from '@api/user-invites.api';
import { MailSink } from '@pages/host-password-link.page';
import { InviteeBrowser } from '@pages/user-invites.page';
import { decodeJwt, isDriversApiReachable, PasswordGrantApi } from '@api/password-grant.api';
import {
  DriverTermsApi,
  PRIVACY_URL,
  TERMS_URL,
  columnsOf,
  hostSignedTerms,
  liveDocCount,
  liveTermsDoc,
  objectExists,
  removeSignedTerms,
  seedSignedTerms,
  signedTerms,
  termsDocByVersion,
  type TermsDoc,
} from '@api/driver-terms.api';

const PURGE = {
  due: 'e2e98801-0988-4988-a988-000000000001',
  future: 'e2e98801-0988-4988-a988-000000000002',
  restored: 'e2e98801-0988-4988-a988-000000000003',
};

function anyActiveHostUuid(): string {
  return queryDriversDb('SELECT TOP 1 LOWER(CONVERT(nvarchar(36), HostUUID)) FROM app.Hosts WHERE Active = 1 ORDER BY HostName') ?? '';
}

test.describe('Driver App Terms of Use and Privacy Policy in the Host table shape (QC-988)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !canUseDriversDb() || !env.driver || !env.driversApiUrl || !env.mobileClientId,
    'Needs DRIVERS_SQL_DATABASE, DRIVER_EMAIL / DRIVER_PASSWORD, DRIVERS_API_URL and MOBILE_CLIENT_ID (local only).',
  );

  let api: DriverTermsApi;
  let accessToken = '';
  let driverId = '';
  let live: TermsDoc;
  let earlier: TermsDoc;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(120_000);
    const request = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    test.skip(!(await isDriversApiReachable(request)), 'The drivers API (DRIVERS_API_URL) is not running.');
    test.skip(!objectExists('auth.UserEULADocs'), 'DRIVERS has no auth.UserEULADocs; the QC-988 migrations have not run.');
    api = new DriverTermsApi(request);
    live = liveTermsDoc();
    earlier = termsDocByVersion('1.0');

    const grant = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
    expect(grant.status, grant.body.error ?? '').toBe(200);
    accessToken = grant.body.access_token!;
    driverId = String(decodeJwt(accessToken).claims['sub']).toLowerCase();
    test.skip(signedTerms(driverId).length !== 0, 'The test driver already has a Terms acceptance that these cases did not make.');
  });

  test.afterAll(() => {
    if (!driverId) return;
    removeSignedTerms(driverId);
    expect(signedTerms(driverId), 'no Terms acceptance is left for the test driver').toEqual([]);
  });

  test('DTERMS-01 GET /terms without a token is 401 and GET /eula is 404', async () => {
    expect((await api.terms(null)).status).toBe(401);
    expect(await api.oldEula(null), 'no token').toBe(404);
    expect(await api.oldEula(accessToken), 'a token').toBe(404);
  });

  test('DTERMS-02 a driver with only Version 1.0 is asked to accept 2.0, with the date and both website links and no text', async () => {
    seedSignedTerms(driverId, earlier, 'QC-988 e2e earlier text');
    try {
      const result = await api.terms(accessToken);

      expect(result.status).toBe(200);
      expect(result.body.data).toEqual({
        version: live.version,
        termsUpdatedOn: live.updatedOn,
        accepted: false,
        acceptedVersion: earlier.version,
        termsUrl: TERMS_URL,
        privacyUrl: PRIVACY_URL,
      });
      expect(result.body.data?.termsUpdatedOn).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
      expect(result.body.data).not.toHaveProperty('text');
      expect(result.body.data).not.toHaveProperty('eulaUuid');
    } finally {
      removeSignedTerms(driverId);
    }
    expect(signedTerms(driverId)).toEqual([]);
  });

  test('DTERMS-03 accepting a wrong version or an empty body is 400 on Version and stores nothing', async ({}, testInfo) => {
    const keys: string[] = [];
    for (const body of [{ version: '9.9' }, {}]) {
      const result = await api.accept(accessToken, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
      const names = Object.keys(result.body.validationErrors ?? {});
      keys.push(...names);
      expect(names.map((key) => key.toLowerCase())).toContain('version');
    }
    testInfo.annotations.push({ type: 'validationErrors keys', description: [...new Set(keys)].join(', ') });
    expect(signedTerms(driverId)).toEqual([]);
  });

  test('DTERMS-04 accepting the live version is 200 and stores one row with that version and no text; again is 200 and still one row', async () => {
    const first = await api.accept(accessToken, { version: live.version });
    expect(first.status).toBe(200);
    expect(first.body.data?.accepted).toBe(true);
    expect(signedTerms(driverId)).toEqual([expect.objectContaining({ docId: live.docId, version: '2.0', textIsNull: true })]);

    const again = await api.accept(accessToken, { version: live.version });
    expect(again.status).toBe(200);
    expect(again.body.data?.accepted).toBe(true);
    expect(signedTerms(driverId)).toHaveLength(1);
  });

  test('DTERMS-05 GET /terms then reports accepted true and acceptedVersion 2.0', async () => {
    const result = await api.terms(accessToken);

    expect(result.status).toBe(200);
    expect(result.body.data?.accepted).toBe(true);
    expect(result.body.data?.acceptedVersion).toBe('2.0');
    expect(result.body.data?.version).toBe(live.version);
  });

  test('DTERMS-12 five parallel accepts for a driver with no 2.0 row are all 200 and store exactly one row with no text', async () => {
    removeSignedTerms(driverId);
    try {
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => api.accept(accessToken, { version: live.version })));

      expect(results.map((result) => result.status)).toEqual([200, 200, 200, 200, 200]);
      expect(results.every((result) => result.body.data?.accepted === true)).toBe(true);
      expect(signedTerms(driverId)).toEqual([expect.objectContaining({ docId: live.docId, version: '2.0', textIsNull: true })]);
    } finally {
      removeSignedTerms(driverId);
      seedSignedTerms(driverId, live, null);
    }
    expect(signedTerms(driverId)).toHaveLength(1);
  });

  test('DTERMS-13 the accepted version is compared trimmed and without case: " 2.0 " is 200 and stores one 2.0 row; 9.9 and an empty body are still 400', async () => {
    removeSignedTerms(driverId);
    try {
      const padded = await api.accept(accessToken, { version: ` ${live.version} ` });
      expect(padded.status).toBe(200);
      expect(padded.body.data?.accepted).toBe(true);
      expect(signedTerms(driverId)).toEqual([expect.objectContaining({ docId: live.docId, version: '2.0', textIsNull: true })]);

      for (const body of [{ version: '9.9' }, {}]) {
        const rejected = await api.accept(accessToken, body);
        expect(rejected.status, JSON.stringify(body)).toBe(400);
        expect(Object.keys(rejected.body.validationErrors ?? {}).map((key) => key.toLowerCase())).toContain('version');
      }
      expect(signedTerms(driverId)).toHaveLength(1);
    } finally {
      removeSignedTerms(driverId);
      seedSignedTerms(driverId, live, null);
    }
    expect(signedTerms(driverId)).toHaveLength(1);
  });

  test('DTERMS-06a DriverInviteAccepted envelope injected with TermsVersion 2.0 and TermsAcceptedAt stores that row and LinkEstablished carries 2.0', async () => {
    test.fixme(
      true,
      'Injecting the envelope is not automatable; the real Host path is DTERMS-06 in the Host to DRIVERS describe below. Original note: only a Host raises DriverInviteAccepted (the Host API is not running and does not send TermsVersion yet), no helper injects the Wolverine envelope into DRIVERS, and none reads the outbound LinkEstablished. Manual: send DriverInviteAccepted for a throwaway UserUUID with TermsVersion 2.0 and TermsAcceptedAt T; expect one auth.UserSignedEULAs row (EULAVersion 2.0, CreatedDate T, UserEULADocText NULL) and LinkEstablished with TermsVersion 2.0 and TermsAcceptedAt T, sent only when the link is new.',
    );
  });

  test('DTERMS-07 DriverInviteAccepted with null terms fields stores nothing; LinkEstablished carries the last accepted version or nulls', async () => {
    test.fixme(
      true,
      'Not automatable here, same reason as DTERMS-06. Manual: with TermsVersion and TermsAcceptedAt null, a person whose only acceptance is 1.0 gets no new row and LinkEstablished carries 1.0 and its CreatedDate; a person with none gets nulls.',
    );
  });

  test('DTERMS-08 an unknown TermsVersion 9.9 stores nothing and the link is still made', async () => {
    test.fixme(
      true,
      'Not automatable here, same reason as DTERMS-06. Manual: send DriverInviteAccepted with TermsVersion 9.9; expect no auth.UserSignedEULAs row for the person and an active app.DriverHostLinks row.',
    );
  });

  test('DTERMS-09 with Terms:RecordHostAcceptance off a Host acceptance is not stored', async () => {
    test.fixme(
      true,
      'Needs a Drivers API restart with Terms__RecordHostAcceptance=false plus a Host event (see DTERMS-06). Manual: restart the API with that setting, send DriverInviteAccepted with TermsVersion 2.0, expect no auth.UserSignedEULAs row but the link made; restart with the setting back on.',
    );
  });

  test('DTERMS-10 the old app tables are gone; the two auth tables have the Host columns; exactly one doc is live', async () => {
    expect(objectExists('app.DriverEulas')).toBe(false);
    expect(objectExists('app.DriverSignedEulas')).toBe(false);
    expect(columnsOf('auth.UserEULADocs')).toEqual(['UserEULADocId', 'Version', 'EULAText', 'IsLive', 'ActiveDate', 'CreatedDate', 'LastModified']);
    expect(columnsOf('auth.UserSignedEULAs')).toEqual(['UserSignedEULAId', 'UserId', 'UserEULADocId', 'EULAVersion', 'CreatedDate', 'UserEULADocText']);
    expect(liveDocCount()).toBe(1);
  });

  test('DTERMS-11 the account purge deletes the purged driver acceptances and keeps those of a driver who is not due', async () => {
    const hostUuid = anyActiveHostUuid();
    test.skip(!hostUuid, 'DRIVERS has no active host for the purge seed.');
    test.skip(queryDriversDb(`SELECT COL_LENGTH(N'app.DriverSettings', N'DeletionRequestedAt')`) === null, 'DRIVERS has no QC-902 deletion migrations.');
    test.setTimeout(210_000);
    const ids = Object.values(PURGE).join(',');
    runDriversSeedScript('drivers-qc902-deletion.remove.sql', { UserIds: ids });
    try {
      runDriversSeedScript('drivers-qc902-purge.apply.sql', { DueUserId: PURGE.due, FutureUserId: PURGE.future, RestoredUserId: PURGE.restored, HostUuid: hostUuid });
      seedSignedTerms(PURGE.due, live, null);
      seedSignedTerms(PURGE.due, earlier, 'earlier');
      seedSignedTerms(PURGE.future, live, null);
      expect(signedTerms(PURGE.due)).toHaveLength(2);

      await expect
        .poll(() => signedTerms(PURGE.due).length, { message: 'the purge removes the due driver acceptances', timeout: 150_000, intervals: [5_000] })
        .toBe(0);
      expect(signedTerms(PURGE.future), 'a driver who is not due keeps the acceptance').toHaveLength(1);
      expect(signedTerms(driverId), 'the DRIVER_EMAIL driver keeps its acceptance').toHaveLength(1);
    } finally {
      for (const id of Object.values(PURGE)) removeSignedTerms(id);
      runDriversSeedScript('drivers-qc902-deletion.remove.sql', { UserIds: ids });
    }
    expect(Object.values(PURGE).flatMap((id) => signedTerms(id))).toEqual([]);
  });
});

test.describe('Host to DRIVERS Terms path: a new Driver accepts the invite with the Terms tick (QC-988)', { tag: ['@write', '@regression'] }, () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });
  test.skip(env.name !== 'local' || !canSeedLocalDb() || !canUseDriversDb() || !canUseIdentityDb(), 'Needs the host, DRIVERS and Identity local databases (local only).');
  test.skip(!env.appApiUrl || !env.driversApiUrl || !env.appAdmin , 'Needs APP_API_URL, DRIVERS_API_URL and APP_ADMIN_*.');

  const person = { email: dflowEmail('terms'), firstName: 'Tess', lastName: 'Terms', password: `Trm!${Date.now().toString(36)}Zq9x`, userId: '', sub: '' };
  let hostUuid = '';
  let batchMark = '0';
  let invites: HostUserInvitesApi;
  let mode: HostDriversMode;
  let originalMode: DriversMode | null = null;
  let seeded = false;
  let sinceLog = 0;

  test.beforeAll(async ({ playwright }) => {
    test.setTimeout(150_000);
    const context = await playwright.request.newContext({ ignoreHTTPSErrors: env.ignoreHttpsErrors });
    test.skip(!(await MailSink.isListening()), `The SMTP sink is not listening on 127.0.0.1:${env.smtpSinkPort}.`);
    test.skip(!(await isDriversApiReachable(context)), 'The drivers API (DRIVERS_API_URL) is not running.');
    test.skip(!driversIsMigrated() || !objectExists('auth.UserEULADocs'), 'DRIVERS is not migrated (QC-902 / QC-988).');
    test.skip(!Qc913Data.hostHasTable('app.UserInvites') || !Qc913Data.sinkIsConfigured(), 'The host has no app.UserInvites or EmailSettings do not point at the SMTP sink.');
    hostUuid = (querySingleValue(`SELECT LOWER(PropertyValue) FROM app.EnvironmentSetting WHERE GroupName = N'Messaging' AND PropertyName = N'HostUuid'`) ?? '').trim();
    test.skip(!hostUuid || queryDriversDb(`SELECT COUNT(*) FROM app.Hosts WHERE HostUUID = '${hostUuid}' AND Active = 1`) !== '1', 'The host is not an active host in DRIVERS.');
    test.skip(!env.hostApiLog || !fs.existsSync(env.hostApiLog), 'HOST_API_LOG does not point at the running host API log.');

    batchMark = querySingleValue(`SELECT ISNULL(MAX(TicketBatchID), 0) FROM app.TicketBatches`) ?? '0';
    removeDflowData(batchMark);
    const world = seedDflowWorld(26, new Intl.DateTimeFormat('en-CA', { timeZone: env.appTimeZone ?? 'America/Chicago' }).format(new Date()));
    seeded = true;

    test.skip(activeInviteKeyCount(hostUuid, 'p1-local-1') !== 1, 'The host invite key p1-local-1 is not registered in HOST_MASTER; register it through the Admin API first (see DFLOW).');

    mode = new HostDriversMode(context);
    originalMode = mode.current();
    await mode.set('On');
    const admin = new DflowHostAdminApi(context);
    expect(await admin.signIn(env.appAdmin!.email, env.appAdmin!.password)).toBe(200);
    invites = new HostUserInvitesApi(context).withToken(admin.bearer());
    const created = await admin.createDriver({ email: person.email, firstName: person.firstName, lastName: person.lastName, truckId: world.truckId });
    expect(created.status, created.text).toBe(201);
    person.userId = created.data!;
    sinceLog = fs.statSync(env.hostApiLog!).size;
  });

  test.afterAll(async () => {
    try {
      await waitForQueues();
    } finally {
      try {
        if (originalMode !== null && mode) await mode.set(originalMode);
      } finally {
        {
          if (seeded) {
            const removed = removeDflowData(batchMark);
            expect(removed.host, 'host rows removed').toMatch(/left=0;leftInvites=0/);
            expect(removed.identity, 'Identity logins removed').toMatch(/left=0/);
            if (removed.drivers !== null) expect(removed.drivers, 'DRIVERS rows removed').toMatch(/leftLinks=0/);
            if (person.sub) expect(signedTerms(person.sub), 'no DRIVERS Terms row is left').toEqual([]);
          }
        }
      }
    }
  });

  test('DTERMS-06 a new Driver accepting with the Terms tick: DRIVERS stores one 2.0 row with no text and the Host stores the version from LinkEstablished', async ({ browser, request }) => {
    test.setTimeout(540_000);
    const since = MailSink.mark();
    const sent = await invites.sendInvite('manageusers', person.userId);
    expect(sent.status, sent.text).toBe(200);
    const mail = await inviteEmailTo(person.email, since);
    await expect
      .poll(() => identityAcceptsLink(request, new URL(mail.acceptUrl).searchParams.get('t')!), { message: 'Identity has loaded the host invite public key', timeout: 400_000, intervals: [5_000, 10_000] })
      .toBe(true);

    const invitee = await InviteeBrowser.open(browser);
    try {
      const outcome = await invitee.acceptAsNew(mail.acceptUrl, { email: person.email, firstName: person.firstName, lastName: person.lastName, password: person.password });
      expect(outcome.status).toBe('recorded');
    } finally {
      await invitee.close();
    }
    person.sub = DflowData.identityUserUuid(person.email) ?? '';
    expect(person.sub).toMatch(/^[0-9a-f-]{36}$/);
    const doc = liveTermsDoc();

    await expect.poll(() => DflowData.activeLinks(hostUuid, person.sub), { message: 'DRIVERS links the driver', timeout: 90_000, intervals: [1_000, 2_000, 5_000] }).toBe(1);
    await expect.poll(() => signedTerms(person.sub).length, { message: 'DRIVERS stores the Host acceptance', timeout: 30_000 }).toBe(1);
    const stored = signedTerms(person.sub);
    expect(stored).toEqual([expect.objectContaining({ docId: doc.docId, version: '2.0', textIsNull: true })]);
    expect(Math.abs(Date.now() - new Date(`${stored[0].createdDate}Z`).getTime()), 'CreatedDate is the Host time of the tick').toBeLessThan(15 * 60_000);
    test.info().annotations.push({ type: 'DRIVERS row', description: JSON.stringify(stored[0]) });

    await expect
      .poll(() => fs.readFileSync(env.hostApiLog!, 'utf8').slice(sinceLog).includes(`Drivers linked invite ${mail.link.payload.jti}`), { message: 'the Host log shows LinkEstablished', timeout: 60_000 })
      .toBe(true);
    const hostRows = hostSignedTerms(person.userId);
    test.info().annotations.push({ type: 'Host rows', description: JSON.stringify(hostRows) });
    expect(hostRows.map((row) => row.version)).toContain('2.0');
  });
});
