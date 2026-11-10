import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { DriversMirrorApi } from '@api/drivers-mirror.api';

/** One Bill rate on a Drivers API assignment (QC-827), PascalCase as the Drivers API sends it. */
export interface DriverRate {
  Code: string;
  Label: string;
  Amount: number;
  Unit: string;
  EffectiveFrom: string;
  WasAmount?: number;
  WasUnit?: string;
  ChangedAt?: string;
}

export interface JobRateRow {
  jobRateId?: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  invoiceRate: number;
  materialsCost: number;
  materialsRate: number;
  billRate: number;
  fuelApplies: boolean;
  fuelRate: number;
  billFuelRate: number;
}

export interface HostAnswer<T = unknown> {
  status: number;
  data: T | null;
  text: string;
}

/**
 * QC-827 host API calls: the Edit Vendor model with driversCanSeeBillRates, the Vendor Portal switch
 * (api/vendor/settings/bill-rates) and the job save that sends JobRatesChanged. Signed in through api/account/login.
 */
export class HostBillRatesApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  async vendorEdit(vendorId: number): Promise<HostAnswer<Record<string, unknown>>> {
    return read(
      await this.request.get(`${hostApiUrl()}/api/organisation/vendor-edit/${vendorId}`, { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors }),
    );
  }

  async billRatesSetting(anonymous = false): Promise<HostAnswer<{ driversCanSeeBillRates: boolean }>> {
    return read(
      await this.request.get(`${hostApiUrl()}/api/vendor/settings/bill-rates`, {
        headers: anonymous ? {} : this.headers(),
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  async saveBillRatesSetting(driversCanSeeBillRates: boolean, anonymous = false): Promise<HostAnswer<{ driversCanSeeBillRates: boolean }>> {
    return read(
      await this.request.post(`${hostApiUrl()}/api/vendor/settings/bill-rates`, {
        headers: anonymous ? {} : this.headers(),
        data: { driversCanSeeBillRates },
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  async job(jobId: number): Promise<Record<string, unknown>> {
    const response = await this.request.get(`${hostApiUrl()}/api/job/${jobId}`, { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() !== 200) throw new Error(`GET api/job/${jobId} answered ${response.status()}`);
    return (await response.json()).data as Record<string, unknown>;
  }

  /** Saves a job the way quarryconnect-ui's job-edit component does (DEVT-10), with the given rate rows in place of the loaded ones. */
  saveJobWithRates(job: Record<string, unknown>, rates: JobRateRow[]): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/job/create-or-update`, {
      headers: this.headers(),
      data: {
        jobId: job.jobId,
        jobDocNameWithPrefix: null,
        customerInfo: job.customerInfo,
        fromTo: job.fromTo,
        rates,
        history: job.history ?? [],
      },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

/** The Drivers API as the throwaway driver: assignment Rates in details, my-assignments and /sync, plus accept and begin-haul. */
export class DriverBillRatesApi extends DriversMirrorApi {
  async rates(orderAssignmentUuid: string): Promise<DriverRate[] | null> {
    const response = await this.details(orderAssignmentUuid);
    if (response.status() !== 200) return null;
    return ((await response.json()).data?.Rates ?? null) as DriverRate[] | null;
  }

  async detailsText(orderAssignmentUuid: string): Promise<string> {
    return (await this.details(orderAssignmentUuid)).text();
  }

  async listedRates(orderAssignmentUuid: string, range: { from?: string; to?: string }): Promise<DriverRate[] | null> {
    const response = await this.myAssignments(range);
    if (response.status() !== 200) throw new Error(`my-assignments answered ${response.status()}`);
    const rows = (await response.json()).data.data as { orderAssignmentUuid: string; Rates?: DriverRate[] }[];
    const row = rows.find((a) => a.orderAssignmentUuid.toLowerCase() === orderAssignmentUuid);
    return row ? (row.Rates ?? null) : null;
  }

  async syncedRates(orderAssignmentUuid: string): Promise<DriverRate[] | null> {
    const response = await this.send({ method: 'GET', path: '/sync' });
    if (response.status() !== 200) throw new Error(`GET /sync answered ${response.status()}`);
    const body = await response.json();
    const rows = ((body.data ?? body).Assignments ?? (body.data ?? body).assignments ?? []) as {
      orderAssignmentUuid?: string;
      OrderAssignmentUUID?: string;
      Rates?: DriverRate[];
    }[];
    const row = rows.find((a) => (a.orderAssignmentUuid ?? a.OrderAssignmentUUID ?? '').toLowerCase() === orderAssignmentUuid);
    return row ? (row.Rates ?? null) : null;
  }

  beginHaulWithTrip(orderAssignmentUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.send({
      method: 'POST',
      path: `/driver/assignments/${orderAssignmentUuid}/begin-haul`,
      data: { tripUuid, deviceStartedAt: new Date(Date.now() - 60_000).toISOString(), isOfflineSync: false },
    });
  }
}

async function read<T>(response: APIResponse): Promise<HostAnswer<T>> {
  const text = await response.text();
  let data: T | null = null;
  try {
    data = (JSON.parse(text) as { data?: T }).data ?? null;
  } catch {
    data = null;
  }
  return { status: response.status(), data, text };
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
