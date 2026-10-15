import { test, expect } from '../../fixtures/test';
import { canSeedLocalDb, runSeedScript } from '../../fixtures/localDb';
import { PlanVsLivePage } from '../../pages/AppPages';

const SEEDED_DAY = new Date(2026, 9, 5);

test.describe('Plan vs Live', { tag: '@write' }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to seed a midnight plan.');

  test.beforeAll(() => {
    runSeedScript('plan-vs-live.apply.sql');
  });

  test.afterAll(() => {
    runSeedScript('plan-vs-live.remove.sql');
  });

  test('PVL-01 a time-shifted assignment draws its plan bar behind its live bar', async ({ page }) => {
    const board = new PlanVsLivePage(page);
    await board.open(SEEDED_DAY);

    const plan = board.shiftedPlanBar();
    await expect(plan).toHaveCount(1);
    await expect(board.planLabel(plan)).toHaveText(/^Plan \d{1,2}:\d{2} [AP]M – \d{1,2}:\d{2} [AP]M$/);

    const live = board.liveBarOf(plan);
    await expect(live).toHaveClass(/\bcmp-bar--shifted\b/);
    await expect(live.locator('.cmp-delta')).toHaveText(/earlier$/);
    await expect(board.liveText(live).first()).toBeVisible();
    expect(await board.topmostIsInside(live)).toBe(true);
  });

  test('PVL-02 an unchanged assignment draws no plan bar', async ({ page }) => {
    const board = new PlanVsLivePage(page);
    await board.open(SEEDED_DAY);

    await expect(board.liveBars).not.toHaveCount(0);
    await expect(board.planBars).toHaveCount(1);
    await expect(board.liveBars.filter({ has: page.locator('.cmp-delta') })).toHaveCount(1);
  });

  test('PVL-03 hovering the plan bar shows only the plan text and hides the live text (QC-658)', async ({ page }) => {
    const board = new PlanVsLivePage(page);
    await board.open(SEEDED_DAY);

    const plan = board.shiftedPlanBar();
    const live = board.liveBarOf(plan);

    await board.hoverPlanOnly(plan, live);

    await expect(board.planLabel(plan)).toBeVisible();
    for (const part of await board.liveText(live).all()) {
      await expect(part).toBeHidden();
    }
    expect(await board.topmostIsInside(plan)).toBe(true);
  });

  test('PVL-04 hovering the live bar brings its text back in front of the plan bar', async ({ page }) => {
    const board = new PlanVsLivePage(page);
    await board.open(SEEDED_DAY);

    const plan = board.shiftedPlanBar();
    const live = board.liveBarOf(plan);

    await board.hoverPlanOnly(plan, live);
    await expect(board.liveText(live).first()).toBeHidden();

    await board.moveAway();
    await board.hoverCentre(live);

    for (const part of await board.liveText(live).all()) {
      await expect(part).toBeVisible();
    }
    expect(await board.topmostIsInside(live)).toBe(true);
  });
});
