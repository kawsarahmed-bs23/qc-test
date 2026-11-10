import type { Page } from '@playwright/test';
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canSeedLocalDb, canUseIdentityDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { CommsPage } from '@pages/app.page';
import { API_CHANNEL, CommsApi, CommsComposer, CommsHostAdmin, MESSAGE_CHANNEL, QC804_ADMIN_STATE } from '@pages/comms-send-gate.page';
import { expectedSmsBody, storedMessageContaining } from '@pages/sms-framing.page';

const MARKER = 'E2E-QC804';
const NO_ASSIGNMENT_IN_APP = "That driver has no assignments, so an in-app message can't reach the app. Send it by SMS instead.";
const INACTIVE_SEND = 'That driver is inactive, so no message can be sent.';
const INACTIVE_REASON = 'This driver is inactive, so no message can be sent.';
const UNREACHABLE_REASON = 'This driver has no phone number and no assignments, so no message can reach them.';
const STATUS_CHECK = 20;
const PING_REFUSED = 'The status check could not be sent. The driver must be active and have an assignment';

const DRIVER_ROLE = `u.Id IN (SELECT ur.UserId FROM auth.UserToRoles ur WHERE ur.RoleName LIKE '%Driver%')`;
const REACHABLE_ACTIVE = `${DRIVER_ROLE} AND u.IsActive = 1 AND ISNULL(u.PhoneNumber, '') <> ''`;
const LIVE_ASSIGNMENT = `FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK
  WHERE a.DriverUserID_FK = u.Id AND a.Active = 1 AND o.Active = 1 AND a.OrderAssignmentStatusID_FK NOT IN (8, 9)`;
const APP_TODAY = `CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)`;
const NEWEST_MESSAGED = `(SELECT TOP 1 m.DriverUserID_FK FROM app.Messages m WHERE m.Active = 1 AND m.DriverUserID_FK IS NOT NULL ORDER BY m.Created DESC)`;

interface GateDrivers {
  planned: string;
  noAssignment: string;
  inactive: string;
  inactiveOriginal: string;
  noAssignmentPhone: string;
}

function pickDrivers(): GateDrivers {
  const planned = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${REACHABLE_ACTIVE}
    AND EXISTS (SELECT 1 ${LIVE_ASSIGNMENT})
    AND NOT EXISTS (SELECT 1 ${LIVE_ASSIGNMENT} AND a.AssignmentDate >= ${APP_TODAY})
    AND u.Id <> ISNULL(${NEWEST_MESSAGED}, '') ORDER BY u.Id`);
  const noAssignment = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${REACHABLE_ACTIVE}
    AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id) ORDER BY u.Id DESC`);
  const inactive = querySingleValue(`SELECT TOP 1 u.Id FROM auth.Users u WHERE ${REACHABLE_ACTIVE}
    AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.DriverUserID_FK = u.Id)
    AND u.Id <> '${noAssignment ?? ''}' ORDER BY u.Id`);
  if (!planned || !noAssignment || !inactive) {
    throw new Error(
      `QC-804 needs an active driver with only past assignments and two active drivers with none (got ${planned}, ${noAssignment}, ${inactive}).`,
    );
  }
  return {
    planned,
    noAssignment,
    inactive,
    inactiveOriginal: querySingleValue(`SELECT CAST(IsActive AS int) FROM auth.Users WHERE Id = '${inactive}'`) ?? '1',
    noAssignmentPhone: querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = '${noAssignment}'`) ?? '',
  };
}

function removeVariables(drivers: GateDrivers): Record<string, string> {
  return {
    InactiveDriverId: drivers.inactive,
    InactiveIsActive: drivers.inactiveOriginal,
    UnreachableDriverId: drivers.noAssignment,
    UnreachablePhone: drivers.noAssignmentPhone,
  };
}

function smsGoesToLogOnly(): boolean {
  return (
    querySingleValue(
      `SELECT COUNT(*) FROM app.EnvironmentSetting WHERE GroupName = 'Twilio' AND PropertyName = 'FromPhoneNumber' AND ISNULL(PropertyValue, '') <> ''`,
    ) === '0'
  );
}

function storedMessage(body: string): { id: number; channel: number; assignment: number | null; sid: string | null } {
  const id = Number(querySingleValue(`SELECT TOP 1 MessageID FROM app.Messages WHERE MessageBody = N'${body}' ORDER BY MessageID DESC`));
  expect(id, `a message stored with body ${body}`).toBeGreaterThan(0);
  const assignment = querySingleValue(`SELECT OrderAssignmentID_FK FROM app.Messages WHERE MessageID = ${id}`);
  return {
    id,
    channel: Number(querySingleValue(`SELECT Channel FROM app.Messages WHERE MessageID = ${id}`)),
    assignment: assignment === null ? null : Number(assignment),
    sid: querySingleValue(`SELECT TwilioMessageSid FROM app.Messages WHERE MessageID = ${id}`),
  };
}

async function snapshot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

test.describe('Comms send gate removed: any active driver can be messaged (QC-804)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed an assignment and toggle a driver.');
  test.skip(!env.appApiUrl, 'APP_API_URL is not set, so the thread and send API cannot be called directly.');
  test.skip(!canUseIdentityDb() || !env.admin, "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway host admin.");
  test.use({ storageState: QC804_ADMIN_STATE });

  let drivers: GateDrivers;
  let assignmentId: number;
  let pastDate: string;

  test.beforeAll(async ({ browser }) => {
    await CommsHostAdmin.signIn(browser);
    drivers = pickDrivers();
    const output = runSeedScript('comms-gate-qc804.apply.sql', { PlannedDriverId: drivers.planned, InactiveDriverId: drivers.inactive });
    const match = output.match(/SEED assignment=(\d+);template=(\d+)/);
    if (!match) {
      runSeedScript('comms-gate-qc804.remove.sql', removeVariables(drivers));
      throw new Error(`The QC-804 seed did not report its rows:\n${output}`);
    }
    assignmentId = Number(match[1]);
    pastDate = querySingleValue(`SELECT CONVERT(varchar(10), AssignmentDate, 23) FROM app.OrderAssignments WHERE OrderAssignmentID = ${match[2]}`) ?? '';
  });

  test.afterAll(() => {
    try {
      if (drivers) runSeedScript('comms-gate-qc804.remove.sql', removeVariables(drivers));
    } finally {
      CommsHostAdmin.remove();
    }
  });

  async function openThread(page: Page, driverUserId: string): Promise<{ composer: CommsComposer; api: CommsApi }> {
    const thread = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith(`/messages/threads/${driverUserId}`), {
      timeout: 30_000,
    });
    await new CommsPage(page).open(driverUserId);
    expect((await thread).ok(), 'GET thread').toBe(true);
    const api = new CommsApi(page, env.appApiUrl!);
    await api.ready();
    return { composer: new CommsComposer(page), api };
  }

  test('GATE-01 a driver whose only live assignment is tomorrow can be messaged and pinged', async ({ page }) => {
    const { composer, api } = await openThread(page, drivers.planned);

    expect(await api.thread(drivers.planned)).toMatchObject({
      canSend: true,
      cannotSendReason: null,
      canSendInApp: true,
      canStatusPing: true,
      activeOrderAssignmentId: assignmentId,
    });

    await expect(composer.input()).toBeEnabled();
    await expect(composer.blockedHint()).toHaveCount(0);
    await expect(composer.hint()).toContainText('Sent by SMS to');
    await expect(composer.toggleButton('In-app')).toBeEnabled();
    await expect(composer.toggleButton('SMS')).toBeEnabled();
    await expect(composer.pingMain()).toBeEnabled();
    await expect(composer.pingCaret()).toBeEnabled();
    await snapshot(page, 'tomorrow-driver-composer');
  });

  test("GATE-02 an in-app send to that driver is stored on tomorrow's assignment", async ({ page }) => {
    const { composer } = await openThread(page, drivers.planned);
    const body = `${MARKER}-INAPP-${Date.now()}`;

    await composer.send(body, 'In-app');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });

    const row = storedMessage(body);
    expect(row.channel).toBe(MESSAGE_CHANNEL.InApp);
    expect(row.assignment).toBe(assignmentId);
    expect(row.sid).toBeNull();
  });

  test("GATE-03 an SMS send to that driver is stored as SMS on tomorrow's assignment", async ({ page }) => {
    test.skip(!smsGoesToLogOnly(), 'Twilio FromPhoneNumber is set in app.EnvironmentSetting, so an SMS would really go out.');
    const { composer } = await openThread(page, drivers.planned);
    const body = `${MARKER}-SMS-${Date.now()}`;
    const expected = expectedSmsBody(querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = '${drivers.planned}'`) ?? '', body);

    await composer.send(body, 'SMS');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });

    const row = storedMessageContaining(body);
    expect(row.body, 'framed with the host name and opt-out line when nothing was texted to that phone lately (QC-780)').toBe(expected);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    expect(row.assignment).toBe(assignmentId);
    expect(row.sid, 'the logging SMS sender stamps a STUB id; a real Twilio id starts SM').toMatch(/^STUB/);
  });

  test('GATE-04 viewing the thread for a past day still allows sending, linked to the nearest assignment', async ({ page }) => {
    expect(pastDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const { api } = await openThread(page, drivers.planned);

    expect(await api.thread(drivers.planned, pastDate)).toMatchObject({
      canSend: true,
      cannotSendReason: null,
      canSendInApp: true,
      canStatusPing: true,
      activeOrderAssignmentId: assignmentId,
    });
  });

  test('GATE-05 a driver with no assignments can get an SMS (no assignment) but not an in-app message or a ping', async ({ page }) => {
    test.skip(!smsGoesToLogOnly(), 'Twilio FromPhoneNumber is set in app.EnvironmentSetting, so an SMS would really go out.');
    const { composer, api } = await openThread(page, drivers.noAssignment);

    expect(await api.thread(drivers.noAssignment)).toMatchObject({
      canSend: true,
      cannotSendReason: null,
      canSendSms: true,
      canSendInApp: false,
      canStatusPing: false,
      activeOrderAssignmentId: null,
    });

    await expect(composer.input()).toBeEnabled();
    await expect(composer.toggleButton('In-app')).toBeDisabled();
    await expect(composer.toggle('SMS')).toHaveClass(/mat-button-toggle-checked/);
    await expect(composer.pingMain()).toBeDisabled();
    await expect(composer.pingCaret()).toBeDisabled();
    await snapshot(page, 'no-assignment-composer');

    const body = `${MARKER}-NOASSIGN-SMS-${Date.now()}`;
    const expected = expectedSmsBody(drivers.noAssignmentPhone, body);
    await composer.send(body, 'SMS');
    await expect(composer.sentText(body)).toBeVisible({ timeout: 15_000 });
    const row = storedMessageContaining(body);
    expect(row.body, 'framed with the host name and opt-out line when nothing was texted to that phone lately (QC-780)').toBe(expected);
    expect(row.channel).toBe(MESSAGE_CHANNEL.Sms);
    expect(row.assignment).toBeNull();
    expect(row.sid).toMatch(/^STUB/);

    const inApp = await api.send(drivers.noAssignment, `${MARKER}-NOASSIGN-INAPP-${Date.now()}`, API_CHANNEL.InApp);
    expect(inApp.status).toBe(400);
    expect(inApp.text).toContain(NO_ASSIGNMENT_IN_APP);

    const ping = await api.ping(drivers.noAssignment, API_CHANNEL.InApp);
    expect(ping.status).toBe(400);
    expect(ping.text).toContain(PING_REFUSED);
    expect(
      Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE DriverUserID_FK = '${drivers.noAssignment}' AND MessageType = ${STATUS_CHECK}`)),
    ).toBe(0);
  });

  test('GATE-06 an inactive driver cannot be messaged or pinged', async ({ page }) => {
    const { composer, api } = await openThread(page, drivers.inactive);

    expect(await api.thread(drivers.inactive)).toMatchObject({
      canSend: false,
      cannotSendReason: INACTIVE_REASON,
      canSendInApp: false,
      canStatusPing: false,
    });

    await expect(composer.blockedHint()).toContainText(INACTIVE_REASON);
    await expect(composer.input()).toBeDisabled();
    await expect(composer.sendButton()).toBeDisabled();
    await expect(composer.pingMain()).toBeDisabled();
    await expect(composer.pingCaret()).toBeDisabled();
    await snapshot(page, 'inactive-driver-composer');

    const before = Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE DriverUserID_FK = '${drivers.inactive}'`));

    const sms = await api.send(drivers.inactive, `${MARKER}-INACTIVE-SMS-${Date.now()}`, API_CHANNEL.Sms);
    expect(sms.status).toBe(400);
    expect(sms.text).toContain(INACTIVE_SEND);

    const inApp = await api.send(drivers.inactive, `${MARKER}-INACTIVE-INAPP-${Date.now()}`, API_CHANNEL.InApp);
    expect(inApp.status).toBe(400);
    expect(inApp.text).toContain(INACTIVE_SEND);

    for (const channel of [API_CHANNEL.InApp, API_CHANNEL.Sms]) {
      const ping = await api.ping(drivers.inactive, channel);
      expect(ping.status, `ping on ${channel}`).toBe(400);
      expect(ping.text).toContain(PING_REFUSED);
    }

    expect(Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE DriverUserID_FK = '${drivers.inactive}'`))).toBe(before);
  });

  test('GATE-07 a driver with no phone and no assignments cannot be messaged, and the composer says why', async ({ page }) => {
    querySingleValue(`UPDATE auth.Users SET PhoneNumber = NULL WHERE Id = '${drivers.noAssignment}'`);
    try {
      const { composer, api } = await openThread(page, drivers.noAssignment);

      expect(await api.thread(drivers.noAssignment)).toMatchObject({
        canSend: false,
        cannotSendReason: UNREACHABLE_REASON,
        canSendSms: false,
        canSendInApp: false,
        canStatusPing: false,
      });
      await expect(composer.blockedHint()).toContainText(UNREACHABLE_REASON);
      await expect(composer.input()).toBeDisabled();
      await expect(composer.pingMain()).toBeDisabled();

      const inApp = await api.send(drivers.noAssignment, `${MARKER}-UNREACHABLE-INAPP-${Date.now()}`, API_CHANNEL.InApp);
      expect(inApp.status).toBe(400);
      const sms = await api.send(drivers.noAssignment, `${MARKER}-UNREACHABLE-SMS-${Date.now()}`, API_CHANNEL.Sms);
      expect(sms.status).toBe(400);
    } finally {
      querySingleValue(
        `UPDATE auth.Users SET PhoneNumber = NULLIF(N'${drivers.noAssignmentPhone.replace(/'/g, "''")}', N'') WHERE Id = '${drivers.noAssignment}'`,
      );
    }
    expect(querySingleValue(`SELECT PhoneNumber FROM auth.Users WHERE Id = '${drivers.noAssignment}'`)).toBe(drivers.noAssignmentPhone);
  });

  test("GATE-08 a Status Ping to the driver planned for tomorrow is posted in-app on tomorrow's assignment", async ({ page }) => {
    const { composer } = await openThread(page, drivers.planned);
    const count = () =>
      Number(querySingleValue(`SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${assignmentId} AND MessageType = ${STATUS_CHECK}`));
    const before = count();

    await composer.pingCaret().click();
    await expect(composer.pingMenuItem('Post in-app only')).toBeEnabled();
    await composer.pingMenuItem('Post in-app only').click();

    await expect.poll(count, { timeout: 15_000 }).toBe(before + 1);
    const pingId = Number(
      querySingleValue(
        `SELECT TOP 1 MessageID FROM app.Messages WHERE OrderAssignmentID_FK = ${assignmentId} AND MessageType = ${STATUS_CHECK} ORDER BY MessageID DESC`,
      ),
    );
    expect(Number(querySingleValue(`SELECT Channel FROM app.Messages WHERE MessageID = ${pingId}`))).toBe(MESSAGE_CHANNEL.InApp);
    expect(querySingleValue(`SELECT TwilioMessageSid FROM app.Messages WHERE MessageID = ${pingId}`)).toBeNull();
  });
});
