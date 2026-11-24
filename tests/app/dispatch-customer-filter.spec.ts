import { test, expect } from '@fixtures/pageFixtures';
import { canSeedLocalDb, querySingleValue } from '@utils/localDb';
import { collectNumbers, jsonData } from '@pages/customer-filter.page';

const DAY = '2026-10-05';
const QUIET_DAY = '2026-09-01';
const CANCELED = 4;

interface Customer {
  id: number;
  name: string;
  jobIds: number[];
}

function customersOn(day: string): Customer[] {
  const raw = querySingleValue(
    `SET NOCOUNT ON; SELECT STRING_AGG(CONCAT(c.OrganisationID, '|', c.OrganisationName, '|', x.JobIds), '~') WITHIN GROUP (ORDER BY c.OrganisationName) ` +
      `FROM auth.Organisations c ` +
      `CROSS APPLY (SELECT STRING_AGG(CAST(j.JobID AS varchar(12)), ',') AS JobIds FROM app.Jobs j WHERE j.CustomerID_FK = c.OrganisationID) x ` +
      `WHERE c.OrganisationID IN (SELECT j.CustomerID_FK FROM app.Orders o JOIN app.Jobs j ON j.JobID = o.JobID_FK ` +
      `WHERE o.Active = 1 AND o.OrderStatusID_FK <> ${CANCELED} AND o.OrderStartDate <= '${day}' AND ISNULL(o.OrderEndDate, o.OrderStartDate) >= '${day}')`,
  );
  return (raw ?? '')
    .split('~')
    .filter(Boolean)
    .map((part) => {
      const [id, name, jobs] = part.split('|');
      return { id: Number(id), name, jobIds: (jobs ?? '').split(',').filter(Boolean).map(Number) };
    });
}

function expectOnlyJobs(found: number[], customer: Customer): void {
  expect(
    found.filter((id) => !customer.jobIds.includes(id)),
    `jobs that are not ${customer.name}'s`,
  ).toEqual([]);
}

test.describe('Dispatch Customer filter (QC-1022)', { tag: ['@regression'] }, () => {
  test.skip(!canSeedLocalDb(), 'Needs the local database (LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE) to know which Customers work on the test day.');

  let customers: Customer[] = [];

  test.beforeAll(() => {
    customers = customersOn(DAY);
    if (customers.length < 2) {
      throw new Error(`The local data needs at least two Customers with an Order on ${DAY}; found ${customers.length}.`);
    }
  });

  test.beforeEach(async ({ dispatchCustomerFilterPage }) => {
    await dispatchCustomerFilterPage.clearSavedFilters();
  });

  test("CF-01 Schedule Board lists only the day's Customers, in name order, and narrows the board to the one picked", async ({
    dispatchCustomerFilterPage: filter,
  }) => {
    await filter.open('schedule', DAY);
    expect(await filter.customerNames()).toEqual(['All Customers', ...customers.map((c) => c.name)]);

    const [first] = customers;
    const board = filter.apiResponse('/api/dispatch/board', (u) => u.searchParams.get('customerId') === String(first.id));
    await filter.pickCustomer(first.name);
    const jobIds = collectNumbers(await jsonData(await board), 'jobId');
    expect(jobIds.length).toBeGreaterThan(0);
    expectOnlyJobs(jobIds, first);
    await filter.expectCustomerChip(first.name);

    const all = filter.apiResponse('/api/dispatch/board', (u) => !u.searchParams.has('customerId'));
    await filter.clearCustomer();
    await all;
  });

  test('CF-02 typing in the Customer drop-down filters its list', async ({ dispatchCustomerFilterPage: filter }) => {
    await filter.open('schedule', DAY);

    const [first, second] = customers;
    const term = second.name.slice(0, 5);
    await filter.searchCustomers(term);
    await expect(filter.customerOption(second.name)).toBeVisible();
    if (!first.name.toLowerCase().includes(term.toLowerCase())) {
      await expect(filter.customerOption(first.name)).toHaveCount(0);
    }
    await filter.customerOption(second.name).click();
    await filter.expectCustomerShown(second.name);
  });

  test('CF-03 a picked Customer stays picked and listed on a day it has no work, and carries over to Orders', async ({
    dispatchCustomerFilterPage: filter,
  }) => {
    const [first] = customers;
    await filter.open('schedule', DAY);
    await filter.pickCustomer(first.name);

    const quietList = filter.apiResponse(
      '/api/dispatch/customers',
      (u) => u.searchParams.get('from') === QUIET_DAY && u.searchParams.get('customerId') === String(first.id),
    );
    const quietBoard = filter.apiResponse(
      '/api/dispatch/board',
      (u) => u.searchParams.get('from') === QUIET_DAY && u.searchParams.get('customerId') === String(first.id),
    );
    await filter.open('schedule', QUIET_DAY);
    const names = ((await jsonData(await quietList)) as { name: string }[]).map((c) => c.name);
    expect(names).toContain(first.name);
    await quietBoard;
    await filter.expectCustomerShown(first.name);

    const orders = filter.apiPost('/api/order/list', (body) => body?.searchCustomerId === first.id);
    await filter.open('orders');
    await orders;
    await filter.expectCustomerShown(first.name);
  });

  test('CF-04 Plan vs Live sends the Customer and shows only its rows', async ({ dispatchCustomerFilterPage: filter }) => {
    const [, second] = customers;
    await filter.open('schedule-comparison', DAY);

    const comparison = filter.apiResponse('/api/dispatch/schedule-comparison', (u) => u.searchParams.get('customerId') === String(second.id));
    await filter.pickCustomer(second.name);
    const jobIds = collectNumbers(await jsonData(await comparison), 'jobId');
    expect(jobIds.length).toBeGreaterThan(0);
    expectOnlyJobs(jobIds, second);
    await filter.expectCustomerChip(second.name);
  });

  test('CF-05 Ticket Activity sends the Customer and shows only its drivers', async ({ dispatchCustomerFilterPage: filter }) => {
    const [first] = customers;
    await filter.open('tickets', DAY);

    const tickets = filter.apiResponse('/api/dispatch/tickets', (u) => u.searchParams.get('customerId') === String(first.id));
    await filter.pickCustomer(first.name);
    const data = (await jsonData(await tickets)) as { rows?: { jobId?: number }[] };
    const rowJobs = (data.rows ?? []).map((r) => r.jobId).filter((id): id is number => typeof id === 'number');
    expect(rowJobs.length).toBeGreaterThan(0);
    expectOnlyJobs(rowJobs, first);
    await filter.expectTicketCards(data.rows?.length ?? 0);
  });

  test('CF-06 Dispatch Home sends the Customer and its pace rows belong to it', async ({ dispatchCustomerFilterPage: filter }) => {
    const [first] = customers;
    await filter.open('dashboard', DAY);

    const dashboard = filter.apiPost('/api/dispatch/dashboard', (body) => body?.searchCustomerId === first.id);
    await filter.pickCustomer(first.name);
    const jobIds = collectNumbers(await jsonData(await dashboard), 'jobId');
    expect(jobIds.length).toBeGreaterThan(0);
    expectOnlyJobs(jobIds, first);
  });

  test('CF-07 Orders lists the Customers in the From–To range and narrows the list to the one picked', async ({ dispatchCustomerFilterPage: filter }) => {
    const [, second] = customers;
    await filter.open('orders');

    const listed = filter.apiResponse('/api/dispatch/customers', (u) => u.searchParams.get('from') === DAY && u.searchParams.get('to') === DAY);
    await filter.setOrdersRange(DAY, DAY);
    await listed;
    expect(await filter.customerNames()).toEqual(['All Customers', ...customers.map((c) => c.name)]);

    const narrowed = filter.apiPost('/api/order/list', (body) => body?.searchCustomerId === second.id);
    await filter.pickCustomer(second.name);
    const jobIds = collectNumbers(await jsonData(await narrowed), 'jobId');
    expect(jobIds.length).toBeGreaterThan(0);
    expectOnlyJobs(jobIds, second);
  });

  test("CF-08 Live Map narrows the Job list to the Customer's Jobs and clears a Job that is not the new Customer's", async ({
    dispatchCustomerFilterPage: filter,
  }) => {
    const [first, second] = customers;
    await filter.open('map', DAY);

    const tracks = filter.apiResponse('/api/dispatch/day-tracks', (u) => u.searchParams.get('customerId') === String(first.id));
    await filter.pickCustomer(first.name);
    const data = (await jsonData(await tracks)) as { jobs: { jobId: number; customerId: number | null }[] };
    expect(data.jobs.length).toBeGreaterThan(0);
    expect(data.jobs.every((j) => j.customerId === first.id)).toBe(true);
    expect(await filter.jobNames()).toHaveLength(data.jobs.length + 1);

    await filter.pickFirstJob();
    await filter.pickCustomer(second.name);
    await filter.expectUrlCustomer(second.id);
    await filter.expectNoJobInUrl();
  });

  test('CF-09 Live Map gives the Customer field the same width as the other filters (QC-1064)', async ({ dispatchCustomerFilterPage: filter, page }) => {
    const [first] = customers;
    await filter.open('map', DAY);
    await filter.pickCustomer(first.name);

    for (const width of [1440, 1200, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(
          async () => {
            const widths = await filter.mapFilterWidths();
            const customer = widths['Customer'];
            const others = Object.entries(widths)
              .filter(([label]) => label !== 'Customer')
              .map(([, w]) => w);
            return customer > 0 && others.length >= 5 && others.every((w) => Math.abs(w - customer) <= 2);
          },
          { message: `filters are not the same width at ${width}px` },
        )
        .toBe(true);
    }
  });
});
