import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { DriversMirrorApi } from '@api/drivers-mirror.api';

/**
 * QC-920: the host API calls that raise the named Wolverine events the Drivers API consumes (JobChanged, JobCanceled,
 * MessageSent, LocationRequested), plus the removed host api/driver-sync route. Signed in through api/account/login.
 */
export class HostDriverEventsApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  setTimeWindow(orderAssignmentId: number, timeWindowStart: string, timeWindowEnd: string): Promise<APIResponse> {
    return this.request.patch(`${hostApiUrl()}/api/assignment/${orderAssignmentId}/time-window`, {
      headers: this.headers(),
      data: { timeWindowStart, timeWindowEnd },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  setStatus(orderAssignmentId: number, status: string, notes: string): Promise<APIResponse> {
    return this.request.patch(`${hostApiUrl()}/api/assignment/${orderAssignmentId}/status`, {
      headers: this.headers(),
      data: { status, notes },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  requestLocation(driverUserId: string, orderAssignmentId: number): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/dispatch/drivers/${driverUserId}/request-location?orderAssignmentId=${orderAssignmentId}`, {
      headers: this.headers(),
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  sendDispatchMessage(driverUserId: string, orderAssignmentId: number, messageBody: string): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/dispatch/messages/send`, {
      headers: this.headers(),
      data: { driverUserId, orderAssignmentId, messageBody, channel: 'InApp' },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  driverSync(method: 'GET' | 'POST'): Promise<APIResponse> {
    return this.request.fetch(`${hostApiUrl()}/api/driver-sync`, {
      method,
      headers: this.headers(),
      data: method === 'POST' ? { operations: [] } : undefined,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  async job(jobId: number): Promise<Record<string, unknown>> {
    const response = await this.request.get(`${hostApiUrl()}/api/job/${jobId}`, { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() !== 200) throw new Error(`GET api/job/${jobId} answered ${response.status()}`);
    return (await response.json()).data as Record<string, unknown>;
  }

  /** Saves a job the way quarryconnect-ui's job-edit component does: the loaded model, no doc name, rate dates as yyyy-MM-dd. */
  saveJobAsTheUiDoes(job: Record<string, unknown>): Promise<APIResponse> {
    const day = (value: unknown) => (typeof value === 'string' && value ? value.slice(0, 10) : null);
    const rates = ((job.rates ?? []) as Record<string, unknown>[]).map((rate) => ({
      ...rate,
      effectiveFrom: day(rate.effectiveFrom),
      effectiveTo: day(rate.effectiveTo),
    }));
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

/** The Drivers API driver writes that raise JobAccepted, TripStarted, GpsTraceUploaded, TripCompleted and DriverMessageSent. */
export class DriverEventsApi extends DriversMirrorApi {
  beginHaulWithTrip(orderAssignmentUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.send({
      method: 'POST',
      path: `/driver/assignments/${orderAssignmentUuid}/begin-haul`,
      data: { tripUuid, deviceStartedAt: new Date(Date.now() - 60_000).toISOString(), isOfflineSync: false },
    });
  }
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
