import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';

export interface AssignmentSave {
  orderId: number;
  assignmentDate: string;
  vendorId: number;
  truckId: number | null;
  driverUserId: string | null;
  truckCount: number | null;
  loadsAssigned: number;
  notes: string;
}

export interface HostAnswer<T = unknown> {
  status: number;
  data: T | null;
  text: string;
}

export interface CopyResult {
  created: number;
  createdAssignmentIds: number[];
}

/** The host API's dispatch assignment endpoints (create, update, copy), signed in through the host's own api/account/login. */
export class HostAssignmentsApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  async create(assignment: AssignmentSave): Promise<HostAnswer<number>> {
    return read(
      await this.request.post(`${hostApiUrl()}/api/order/${assignment.orderId}/assignment`, {
        headers: this.headers(),
        data: body(assignment),
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  async update(orderAssignmentId: number, assignment: AssignmentSave): Promise<HostAnswer<number>> {
    return read(
      await this.request.put(`${hostApiUrl()}/api/assignment/${orderAssignmentId}`, {
        headers: this.headers(),
        data: { ...body(assignment), orderAssignmentId },
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  async copy(sourceDate: string, orderAssignmentIds: number[], targetDates: string[]): Promise<HostAnswer<CopyResult>> {
    return read(
      await this.request.post(`${hostApiUrl()}/api/assignment/copy`, {
        headers: this.headers(),
        data: { sourceDate, orderAssignmentIds, targetDates, extendOrderIds: [], notifyDrivers: false },
        ignoreHTTPSErrors: env.ignoreHttpsErrors,
      }),
    );
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

function body(assignment: AssignmentSave): Record<string, unknown> {
  return {
    orderId: assignment.orderId,
    assignmentDate: assignment.assignmentDate,
    vendorId: assignment.vendorId,
    truckId: assignment.truckId,
    driverUserId: assignment.driverUserId,
    truckCount: assignment.truckCount,
    timeWindowStart: '06:00:00',
    timeWindowEnd: '18:00:00',
    loadsAssigned: assignment.loadsAssigned,
    fulfillmentType: 'fixed',
    notes: assignment.notes,
    sendSms: false,
    smsBody: null,
    histories: [],
  };
}

async function read<T>(response: APIResponse): Promise<HostAnswer<T>> {
  const text = await response.text();
  let data: T | null = null;
  try {
    data = text ? ((JSON.parse(text) as { data?: T }).data ?? null) : null;
  } catch {
    data = null;
  }
  return { status: response.status(), data, text };
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
