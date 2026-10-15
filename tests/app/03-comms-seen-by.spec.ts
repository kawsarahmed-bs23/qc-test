import type { Locator } from '@playwright/test';
import { test, expect } from '../../fixtures/test';
import { canSeedLocalDb, runSeedScript } from '../../fixtures/localDb';
import { CommsPage } from '../../pages/AppPages';

const READ_GREEN = 'rgb(46, 212, 126)';
const UNREAD_GRAY = 'rgb(187, 187, 187)';
const APP_DATE_TIME = '\\d{2}/\\d{2}/\\d{4} \\d{2}:\\d{2}(AM|PM)';

interface SeededThread {
  autoId: number;
  queueId: number;
  outReadId: number;
  outUnreadId: number;
  driverUserId: string;
}

function parseSeededThread(output: string): SeededThread {
  const match = output.match(/SEED auto=(\d+);queue=(\d+);outRead=(\d+);outUnread=(\d+);driver=([^;\s]+)/);
  if (!match) {
    throw new Error(`The read-receipt seed did not report its rows:\n${output}`);
  }
  return {
    autoId: Number(match[1]),
    queueId: Number(match[2]),
    outReadId: Number(match[3]),
    outUnreadId: Number(match[4]),
    driverUserId: match[5],
  };
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) {
    throw new Error('Element has no bounding box; it is not rendered.');
  }
  return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height, height: b.height };
}

test.describe('Comms read receipts as chat-style ticks (QC-685)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed read and unread messages.');

  let seeded: SeededThread;
  let comms: CommsPage;
  let all: number[];

  test.beforeAll(() => {
    seeded = parseSeededThread(runSeedScript('comms-seen-by.apply.sql'));
    all = [seeded.autoId, seeded.queueId, seeded.outReadId, seeded.outUnreadId];
  });

  test.afterAll(() => {
    runSeedScript('comms-seen-by.remove.sql');
  });

  test.beforeEach(async ({ page }) => {
    comms = new CommsPage(page);
    await comms.open(seeded.driverUserId);
    for (const id of all) {
      await expect(comms.message(id)).toBeVisible({ timeout: 30_000 });
    }
  });

  test('SEEN-01 every read receipt is a double-tick icon with no text beside it', async () => {
    for (const id of all) {
      await expect(comms.readReceipt(id).locator('mat-icon'), `message ${id}`).toHaveText('done_all');
      await expect(comms.readReceipt(id), `message ${id}`).toHaveText('done_all');
    }
    await expect(comms.messageFooter(seeded.autoId)).not.toContainText('Seen by');
    await expect(comms.messageFooter(seeded.outUnreadId)).not.toContainText(/Not seen yet|No read receipt/);
  });

  test('SEEN-02 hovering the tick on a driver message shows which dispatcher saw it and when', async () => {
    for (const id of [seeded.autoId, seeded.queueId]) {
      await expect(comms.readReceipt(id), `message ${id}`).toHaveCSS('color', READ_GREEN);
      await comms.readReceipt(id).hover();
      await expect(comms.tooltip()).toHaveText(new RegExp(`^Seen by .+ · ${APP_DATE_TIME}$`));
      await comms.messageText(id).hover();
      await expect(comms.tooltip()).toHaveCount(0);
    }
  });

  test('SEEN-03 a message the driver has read shows a green tick; hovering shows when', async () => {
    const receipt = comms.readReceipt(seeded.outReadId);
    await expect(receipt).toHaveCSS('color', READ_GREEN);
    await receipt.hover();
    await expect(comms.tooltip()).toHaveText(new RegExp(`^Seen by driver · ${APP_DATE_TIME}$`));
  });

  test('SEEN-04 a message the driver has not read shows a gray tick; hovering explains why', async () => {
    const receipt = comms.readReceipt(seeded.outUnreadId);
    await expect(receipt).toHaveCSS('color', UNREAD_GRAY);
    await expect(receipt).toHaveCSS('opacity', '1');
    await receipt.hover();
    await expect(comms.tooltip()).toHaveText(/^(Not seen yet\.|No read receipt \(SMS\)\.)/);
  });

  test('SEEN-05 the tick sits at the bottom-right of the bubble, clear of the time, with tags kept left', async () => {
    for (const id of all) {
      const bubble = await box(comms.bubble(id));
      const time = await box(comms.messageTime(id));
      const tick = await box(comms.readReceipt(id));
      const sameLine = tick.top < time.bottom;
      const clearance = sameLine ? tick.left - time.right : tick.top - time.bottom;
      expect(clearance, `space between time and tick in message ${id}`).toBeGreaterThanOrEqual(5.5);
      expect(bubble.right - tick.right, `tick hugs the bubble's right padding in message ${id}`).toBeLessThanOrEqual(16);
    }
    const footer = await box(comms.messageFooter(seeded.queueId));
    const tag = await box(comms.footerTags(seeded.queueId).first());
    await expect(comms.footerTags(seeded.queueId).first()).toContainText('Needs Review');
    expect(tag.left - footer.left, 'Needs Review starts at the footer left edge').toBeLessThan(1.5);
  });

  test('SEEN-06 the footer has a 6px gap and clear space under the message text', async () => {
    for (const id of all) {
      await expect(comms.messageFooter(id)).toHaveCSS('gap', '6px');
      const text = await box(comms.messageText(id));
      const footer = await box(comms.messageFooter(id));
      expect(footer.top - text.bottom, `space above the footer in message ${id}`).toBeGreaterThanOrEqual(9.5);
    }
  });
});
