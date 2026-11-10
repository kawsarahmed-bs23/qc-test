import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';

export const TRUCK_NUMBER_MAX = 100;

export interface DriverSettings {
  TruckNumber: string | null;
}

export interface DriversEnvelope<T> {
  data?: T | null;
  message?: string | null;
  errors?: string[];
  validationErrors?: Record<string, string[]>;
}

export interface DriversResult<T> {
  status: number;
  body: DriversEnvelope<T>;
}

export interface AsHauledAssignment {
  HostUUID: string;
  orderAssignmentUuid: string;
  HostName: string | null;
  VendorUUID: string | null;
  VendorName: string | null;
  TruckUUID: string | null;
  TruckName: string | null;
  truckNumber: string | null;
}

export interface DriverThreadList {
  driverName: string | null;
  truckNumber: string | null;
  threads: { orderAssignmentUuid: string }[];
}

export interface DriverThread {
  orderAssignmentUuid: string;
  truckNumber: string | null;
}

/** The Driver's own settings (QC-902 `GET/PUT /me/settings`) and the work reads that show its as-hauled data (one list across Hosts, no X-Host-Uuid). */
export class DriverSettingsApi {
  constructor(private readonly request: APIRequestContext) {}

  settings(accessToken: string | null): Promise<DriversResult<DriverSettings>> {
    return this.read(this.request.get(`${baseUrl()}/me/settings`, { headers: headers(accessToken) }));
  }

  saveSettings(accessToken: string | null, body: Partial<DriverSettings>): Promise<DriversResult<DriverSettings>> {
    return this.read(this.request.put(`${baseUrl()}/me/settings`, { headers: headers(accessToken), data: body }));
  }

  assignment(accessToken: string, orderAssignmentUuid: string): Promise<DriversResult<AsHauledAssignment>> {
    return this.read(this.request.get(`${baseUrl()}/driver-assignment/details/${orderAssignmentUuid}`, { headers: headers(accessToken) }));
  }

  syncAssignments(accessToken: string): Promise<DriversResult<{ assignments: AsHauledAssignment[] }>> {
    return this.read(this.request.get(`${baseUrl()}/sync`, { headers: headers(accessToken) }));
  }

  threads(accessToken: string): Promise<DriversResult<DriverThreadList>> {
    return this.read(this.request.get(`${baseUrl()}/driver-message/threads`, { headers: headers(accessToken) }));
  }

  thread(accessToken: string, orderAssignmentUuid: string): Promise<DriversResult<DriverThread>> {
    return this.read(this.request.get(`${baseUrl()}/driver-message/threads/${orderAssignmentUuid}`, { headers: headers(accessToken) }));
  }

  private async read<T>(pending: Promise<APIResponse>): Promise<DriversResult<T>> {
    const response = await pending;
    const text = await response.text();
    let body: DriversEnvelope<T> = {};
    try {
      body = text ? (JSON.parse(text) as DriversEnvelope<T>) : {};
    } catch {
      body = { message: text };
    }
    return { status: response.status(), body };
  }
}

function headers(accessToken: string | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (accessToken !== null) result.Authorization = `Bearer ${accessToken}`;
  return result;
}

function baseUrl(): string {
  if (!env.driversApiUrl) {
    throw new Error('DRIVERS_API_URL is not set.');
  }
  return env.driversApiUrl;
}
