import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, querySingleValue, runSeedScript } from '@utils/localDb';
import { DispatchOrdersPage, type ElementBox } from '@pages/app.page';
import { reportScreenshotPath } from '@pages/platform.page';

const SEEDED_ORDER = 26;
const SEEDED_TRUCK_TYPE = 'Lightweight End Dump';
const EXISTING_LONG_TRUCK_TYPE = 'Half Round End Dump';
const LONG_NAME_LENGTH = 15;
const RANGE_FROM = new Date(2026, 7, 31);
const RANGE_TO = new Date(2026, 9, 2);
const TOLERANCE = 1;

interface LongNameRow {
  orderId: number;
  truckType: string;
  pill: ElementBox;
  truckTypeCell: ElementBox;
  dateCell: ElementBox;
  dateText: string;
  dateScrollWidth: number;
  dateClientWidth: number;
}

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function truckTypeOf(orderId: number): string | null {
  return querySingleValue(`SELECT TruckTypeID_FK FROM app.Orders WHERE OrderID = ${orderId}`);
}

function isInside(inner: ElementBox, outer: ElementBox): boolean {
  return (
    inner.x >= outer.x - TOLERANCE &&
    inner.y >= outer.y - TOLERANCE &&
    inner.x + inner.width <= outer.x + outer.width + TOLERANCE &&
    inner.y + inner.height <= outer.y + outer.height + TOLERANCE
  );
}

function intersects(a: ElementBox, b: ElementBox): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function rounded(box: ElementBox): ElementBox {
  const r = (n: number) => Math.round(n * 10) / 10;
  return { x: r(box.x), y: r(box.y), width: r(box.width), height: r(box.height) };
}

test.describe('Dispatch Orders grid keeps a long truck type inside its column (QC-828)', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to give an order a long truck type.');
  test.describe.configure({ mode: 'serial' });

  let originalTruckTypeId: string | null = null;

  test.beforeAll(() => {
    const seededTypeId = querySingleValue(`SELECT TruckTypeID FROM app.List_TruckTypes WHERE TruckTypeName = ${sqlText(SEEDED_TRUCK_TYPE)} AND Active = 1`);
    if (!seededTypeId) {
      throw new Error(`The local data has no active "${SEEDED_TRUCK_TYPE}" truck type.`);
    }

    const current = truckTypeOf(SEEDED_ORDER);
    if (!current) {
      throw new Error(`Local order ${SEEDED_ORDER} does not exist or has no truck type.`);
    }
    if (current === seededTypeId) {
      throw new Error(
        `Order ${SEEDED_ORDER} already has truck type ${seededTypeId}; an earlier run may not have restored it. Put its original type back first.`,
      );
    }

    const output = runSeedScript('orders-grid-qc828.apply.sql', { OrderId: String(SEEDED_ORDER), TruckTypeId: seededTypeId });
    const reported = output.match(/SEED order=\d+;original=(\d+)/)?.[1];
    expect(reported, 'the seed reports the original truck type').toBe(current);
    originalTruckTypeId = current;
  });

  test.afterAll(() => {
    if (originalTruckTypeId === null) {
      return;
    }
    runSeedScript('orders-grid-qc828.remove.sql', { OrderId: String(SEEDED_ORDER), OriginalTruckTypeId: originalTruckTypeId });
    expect(truckTypeOf(SEEDED_ORDER), `order ${SEEDED_ORDER} has its original truck type again`).toBe(originalTruckTypeId);
  });

  for (const { id, width } of [
    { id: 'ORDGRID-01', width: 1100 },
    { id: 'ORDGRID-02', width: 1440 },
  ]) {
    test(`${id} at ${width}px wide a long truck type pill stays inside its column and clear of the Date column, whose text is not clipped`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const orders = new DispatchOrdersPage(page);
      await orders.open();
      await orders.showRange(RANGE_FROM, RANGE_TO);
      await expect(orders.truckTypePill(orders.row(SEEDED_ORDER))).toHaveText(SEEDED_TRUCK_TYPE);

      const measured: LongNameRow[] = [];
      for (const row of await orders.rows.all()) {
        const pill = orders.truckTypePill(row);
        if ((await pill.count()) === 0) {
          continue;
        }
        const truckType = (await pill.innerText()).trim();
        if (truckType.length < LONG_NAME_LENGTH) {
          continue;
        }
        const dateCell = orders.dateCell(row);
        const overflow = await orders.textOverflow(dateCell);
        measured.push({
          orderId: await orders.orderIdOf(row),
          truckType,
          pill: rounded(await orders.box(pill)),
          truckTypeCell: rounded(await orders.box(orders.truckTypeCell(row))),
          dateCell: rounded(await orders.box(dateCell)),
          dateText: (await dateCell.innerText()).trim(),
          dateScrollWidth: overflow.scrollWidth,
          dateClientWidth: overflow.clientWidth,
        });
      }

      const screenshot = reportScreenshotPath(`orders-grid-${width}.png`);
      fs.mkdirSync(path.dirname(screenshot), { recursive: true });
      await orders.table.screenshot({ path: screenshot });
      test.info().annotations.push({ type: 'screenshot', description: screenshot });
      test.info().annotations.push({ type: 'measured', description: JSON.stringify(measured) });

      expect(
        measured.map((m) => m.truckType),
        'both long truck types are on screen',
      ).toEqual(expect.arrayContaining([SEEDED_TRUCK_TYPE, EXISTING_LONG_TRUCK_TYPE]));

      for (const m of measured) {
        const label = `order #${m.orderId} (${m.truckType}): ${JSON.stringify(m)}`;
        expect.soft(isInside(m.pill, m.truckTypeCell), `the pill sits inside its Truck Type cell, ${label}`).toBe(true);
        expect.soft(intersects(m.pill, m.dateCell), `the pill does not reach the Date cell, ${label}`).toBe(false);
        expect.soft(m.dateScrollWidth, `the Date text fits its cell, ${label}`).toBeLessThanOrEqual(m.dateClientWidth);
      }
    });
  }
});
