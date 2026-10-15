import { request as playwrightRequest } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../../fixtures/test';
import { canSeedLocalDb, querySingleValue, runSeedScript } from '../../fixtures/localDb';
import { CommsPage } from '../../pages/AppPages';

// Never click anything that sends over SMS here: the local API may hold live Twilio credentials,
// and the seeded drivers' numbers are not ours. Only the in-app channel is exercised end to end;
// the SMS option is checked for presence and state only.

const CHANNEL_SMS = 10;
const CHANNEL_IN_APP = 20;
const UNMATCHED_PHONE = '+15550100630';

interface SeededChannels {
  smsId: number;
  inAppId: number;
  unmatchedId: number;
  assignmentId: number;
  driverUserId: string;
}

function parseSeed(output: string): SeededChannels {
  const match = output.match(/SEED sms=(\d+);inApp=(\d+);unmatched=(\d+);assignment=(\d+);driver=([^;\s]+)/);
  if (!match) {
    throw new Error(`The channel seed did not report its rows:\n${output}`);
  }
  return {
    smsId: Number(match[1]),
    inAppId: Number(match[2]),
    unmatchedId: Number(match[3]),
    assignmentId: Number(match[4]),
    driverUserId: match[5],
  };
}

function messageIdByBody(body: string): number {
  const id = querySingleValue(`SELECT TOP 1 MessageID FROM app.Messages WHERE MessageBody = N'${body}' ORDER BY MessageID DESC`);
  if (!id) {
    throw new Error(`No message was stored with body ${body}.`);
  }
  return Number(id);
}

async function snapshot(page: Page, name: string): Promise<void> {
  await test.info().attach(name, { body: await page.screenshot(), contentType: 'image/png' });
}

function channelOf(messageId: number): number {
  return Number(querySingleValue(`SELECT Channel FROM app.Messages WHERE MessageID = ${messageId}`));
}

class ChannelComms {
  constructor(private readonly page: Page) {}

  channelBadge(messageId: number): Locator {
    return this.page.locator(`#msg-${messageId} .msg-channel`);
  }

  toggle(label: 'SMS' | 'In-app'): Locator {
    return this.page.locator('.channel-toggle mat-button-toggle').filter({ hasText: label });
  }

  warning(): Locator {
    return this.page.locator('.channel-warning');
  }

  hint(): Locator {
    return this.page.locator('.reply-hint');
  }

  composer(): Locator {
    return this.page.locator('.reply-input');
  }

  sendButton(): Locator {
    return this.page.locator('.thread-reply button').filter({ hasText: 'Send' });
  }

  pingMain(): Locator {
    return this.page.locator('.ping-split__main');
  }

  pingCaret(): Locator {
    return this.page.locator('.ping-split__caret');
  }

  menuItem(text: string): Locator {
    return this.page.locator('.mat-mdc-menu-item').filter({ hasText: text });
  }

  queueButton(): Locator {
    return this.page.locator('.queue-tab-btn');
  }

  queueItem(messageId: number): Locator {
    return this.page.locator(`#queue-${messageId}`);
  }

  dialog(): Locator {
    return this.page.locator('mat-dialog-container');
  }
}

test.describe('Comms channel choice and unmatched inbound SMS (QC-630)', { tag: '@write' }, () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed an assignment and messages.');

  let seeded: SeededChannels;
  let driverName: string;
  let comms: CommsPage;
  let ui: ChannelComms;

  test.beforeAll(() => {
    seeded = parseSeed(runSeedScript('comms-channel.apply.sql'));
    driverName = querySingleValue(
      `SELECT LTRIM(RTRIM(CONCAT(FirstName, ' ', LastName))) FROM auth.Users WHERE Id = '${seeded.driverUserId}'`,
    ) ?? '';
  });

  test.afterAll(() => {
    runSeedScript('comms-channel.remove.sql');
  });

  test.beforeEach(async ({ page }) => {
    comms = new CommsPage(page);
    ui = new ChannelComms(page);
    await comms.open(seeded.driverUserId);
    await expect(comms.message(seeded.smsId)).toBeVisible({ timeout: 30_000 });
  });

  test('CHAN-01 each message in the thread shows the channel it went out on', async () => {
    await expect(ui.channelBadge(seeded.smsId)).toContainText('SMS');
    await expect(ui.channelBadge(seeded.inAppId)).toContainText('In-app');

    await ui.channelBadge(seeded.inAppId).hover();
    await expect(comms.tooltip()).toHaveText('In-app only. No SMS was sent.');
  });

  test('CHAN-02 the composer offers SMS and In-app and starts on the manual-message default (SMS)', async () => {
    await expect(ui.toggle('SMS')).toBeVisible();
    await expect(ui.toggle('In-app')).toBeVisible();
    await expect(ui.toggle('SMS')).toHaveClass(/mat-button-toggle-checked/);
    await expect(ui.hint()).toContainText('Sent by SMS to');
    await expect(ui.hint()).toContainText('also shown in the app');
  });

  test('CHAN-03 choosing In-app for a driver who has not used the app warns, and keeps In-app selected', async ({ page }) => {
    const inactive = querySingleValue(
      `SELECT CASE WHEN LastLoginDate < DATEADD(DAY, -14, SYSUTCDATETIME()) THEN 1 ELSE 0 END FROM auth.Users WHERE Id = '${seeded.driverUserId}'`,
    );
    test.skip(inactive !== '1', 'The seeded driver has logged in within 14 days, so no warning is due.');

    await expect(ui.warning()).toHaveCount(0);
    await ui.toggle('In-app').click();

    await expect(ui.warning()).toBeVisible();
    await expect(ui.warning()).toContainText('They will not see an in-app message.');
    await expect(ui.toggle('In-app')).toHaveClass(/mat-button-toggle-checked/);
    await expect(ui.hint()).toContainText('no SMS is sent');
    await snapshot(page, 'in-app-warning');
  });

  test('CHAN-04 an In-app send is stored as In-app with no Twilio id, and shows in the thread', async ({ page }) => {
    const body = `E2E-QC630-SEND-INAPP-${Date.now()}`;

    await ui.toggle('In-app').click();
    await ui.composer().fill(body);
    await ui.sendButton().click();

    await expect(page.locator('.msg-text', { hasText: body })).toBeVisible({ timeout: 15_000 });

    const id = messageIdByBody(body);
    expect(channelOf(id)).toBe(CHANNEL_IN_APP);
    expect(querySingleValue(`SELECT TwilioMessageSid FROM app.Messages WHERE MessageID = ${id}`)).toBeNull();
    expect(querySingleValue(`SELECT PhoneNumber FROM app.Messages WHERE MessageID = ${id}`)).not.toBeNull();
    await expect(ui.channelBadge(id)).toContainText('In-app');
  });

  test('CHAN-05 Status Ping defaults to In-app and offers the other channel from its menu', async ({ page }) => {
    await expect(ui.pingMain()).toContainText('In-app');

    await ui.pingCaret().click();
    await expect(ui.menuItem('Send by SMS')).toBeVisible();
    await expect(ui.menuItem('Post in-app only')).toBeVisible();
    await page.locator('.mat-mdc-menu-panel').evaluate((panel) =>
      Promise.all(panel.getAnimations({ subtree: true }).map((animation) => animation.finished)));
    await snapshot(page, 'status-ping-menu');
    await page.keyboard.press('Escape');

    const before = Number(querySingleValue(
      `SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.assignmentId} AND MessageType = 20`,
    ));

    await ui.pingMain().click();
    await expect(page.locator('.msg-tag--status').last()).toBeVisible({ timeout: 15_000 });

    await expect.poll(() => Number(querySingleValue(
      `SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.assignmentId} AND MessageType = 20`,
    ))).toBe(before + 1);

    const pingId = Number(querySingleValue(
      `SELECT TOP 1 MessageID FROM app.Messages WHERE OrderAssignmentID_FK = ${seeded.assignmentId} AND MessageType = 20 ORDER BY MessageID DESC`,
    ));
    expect(channelOf(pingId)).toBe(CHANNEL_IN_APP);
    expect(querySingleValue(`SELECT TwilioMessageSid FROM app.Messages WHERE MessageID = ${pingId}`)).toBeNull();
    await expect(ui.channelBadge(pingId)).toContainText('In-app');
  });

  test('CHAN-06 an inbound SMS no driver matches waits in the queue and can be attached to a driver', async ({ page }) => {
    test.skip(!driverName, 'The seeded driver has no name to search for.');

    await ui.queueButton().click();
    const item = ui.queueItem(seeded.unmatchedId);
    await expect(item).toBeVisible();
    await expect(item).toContainText('Unknown sender');
    await expect(item).toContainText(UNMATCHED_PHONE);
    await expect(item.locator('.msg-tag--unmatched')).toHaveText('Unmatched');
    await snapshot(page, 'unmatched-queue');

    await item.getByRole('button', { name: /Attach to driver/ }).click();
    const dialog = ui.dialog();
    await expect(dialog).toBeVisible();
    await dialog.locator('input').fill(driverName.split(' ')[0]);

    const option = page.locator('mat-option').filter({
      has: page.locator('.attach-dialog__option-name', { hasText: new RegExp(`^\\s*${driverName}\\s*$`) }),
    });
    await expect(option.first()).toBeVisible();
    await snapshot(page, 'attach-dialog');
    await option.first().click();
    await dialog.getByRole('button', { name: 'Attach' }).click();
    await expect(dialog).toHaveCount(0);

    await expect(comms.message(seeded.unmatchedId)).toBeVisible({ timeout: 15_000 });
    await snapshot(page, 'attached-in-thread');
    expect(querySingleValue(`SELECT DriverUserID_FK FROM app.Messages WHERE MessageID = ${seeded.unmatchedId}`))
      .toBe(seeded.driverUserId);
    expect(Number(querySingleValue(`SELECT OrderAssignmentID_FK FROM app.Messages WHERE MessageID = ${seeded.unmatchedId}`)))
      .toBe(seeded.assignmentId);
  });

  test('CHAN-07 after attaching, the next text from that number lands with the same driver', async () => {
    const apiUrl = process.env.APP_API_URL?.trim();
    test.skip(!apiUrl, 'APP_API_URL is not set, so the Twilio webhook cannot be called.');

    const body = `E2E-QC630-IN-AFTER-ATTACH-${Date.now()}`;
    const api = await playwrightRequest.newContext({ ignoreHTTPSErrors: true });
    const response = await api.post(`${apiUrl}/api/dispatch/messages/inbound`, {
      form: { MessageSid: `SME630${Date.now()}`, From: UNMATCHED_PHONE, To: '+15005550006', Body: body },
    });
    await api.dispose();

    test.skip(response.status() === 403, 'The local API validates Twilio signatures (Twilio:ValidateSignature), so an unsigned webhook is refused.');
    expect(response.status()).toBe(204);

    const id = messageIdByBody(body);
    expect(querySingleValue(`SELECT DriverUserID_FK FROM app.Messages WHERE MessageID = ${id}`)).toBe(seeded.driverUserId);
    expect(Number(querySingleValue(`SELECT OrderAssignmentID_FK FROM app.Messages WHERE MessageID = ${id}`))).toBe(seeded.assignmentId);
    expect(channelOf(id)).toBe(CHANNEL_SMS);
  });
});
