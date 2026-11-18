import { test, expect } from '@fixtures/pageFixtures';

const PO = 'E2E-QC993-DRAFT';

test.describe('Job draft is kept in the browser and offered back (QC-993)', { tag: ['@regression'] }, () => {
  test.beforeEach(async ({ jobDraftPage }) => {
    await jobDraftPage.open();
    await jobDraftPage.expectFormReady();
    await jobDraftPage.clearDrafts();
  });

  test.afterEach(async ({ jobDraftPage }) => {
    await jobDraftPage.clearDrafts();
  });

  test('JDRAFT-01 a change to the new Job form is saved as a draft after a second, and not before the user changes something', async ({ jobDraftPage }) => {
    expect(await jobDraftPage.draftKeys()).toEqual([]);

    await jobDraftPage.typeCustomerPo(PO);

    await expect.poll(() => jobDraftPage.draftKeys(), { timeout: 10_000 }).toHaveLength(1);
    expect(await jobDraftPage.draftText()).toContain(PO);
  });

  test('JDRAFT-02 after a reload the dialog offers the draft and Restore brings the values back', async ({ jobDraftPage }) => {
    await jobDraftPage.typeCustomerPo(PO);
    await expect.poll(() => jobDraftPage.draftKeys(), { timeout: 10_000 }).toHaveLength(1);

    await jobDraftPage.reload();
    await expect(jobDraftPage.restoreDialog).toBeVisible({ timeout: 30_000 });
    await jobDraftPage.restore.click();

    await expect(jobDraftPage.restoreDialog).toHaveCount(0);
    await expect(jobDraftPage.customerPo).toHaveValue(PO);
  });

  test('JDRAFT-03 Discard clears the draft and leaves the form empty', async ({ jobDraftPage }) => {
    await jobDraftPage.typeCustomerPo(PO);
    await expect.poll(() => jobDraftPage.draftKeys(), { timeout: 10_000 }).toHaveLength(1);

    await jobDraftPage.reload();
    await expect(jobDraftPage.restoreDialog).toBeVisible({ timeout: 30_000 });
    await jobDraftPage.discard.click();

    await expect(jobDraftPage.restoreDialog).toHaveCount(0);
    await expect(jobDraftPage.customerPo).toHaveValue('');
    expect(await jobDraftPage.draftKeys()).toEqual([]);
  });

  test('JDRAFT-04 Cancel clears the draft', async ({ jobDraftPage }) => {
    await jobDraftPage.typeCustomerPo(PO);
    await expect.poll(() => jobDraftPage.draftKeys(), { timeout: 10_000 }).toHaveLength(1);

    await jobDraftPage.cancel.click();

    await expect(jobDraftPage.customerPo).toHaveCount(0);
    expect(await jobDraftPage.draftKeys()).toEqual([]);
  });
});
