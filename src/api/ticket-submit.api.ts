import { createHash } from 'crypto';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { DriverEventsApi } from '@api/driver-events.api';
import { HOST_HEADER, type LocationPing } from '@api/drivers-mirror.api';
import { CONTENT_HASH_HEADER, IDEMPOTENCY_KEY_HEADER, type SyncOperation, type SyncOperationResult, type TicketFile } from '@api/driver-sync.api';

/** A QC-873 location point: the phone's TripGpsUUID, the host a Share my location answer is for, and whether the driver sent it by hand. */
export interface GpsPing extends LocationPing {
  TripGpsUUID?: string;
  HostUUID?: string;
  LocationRequestUUID?: string;
  isManual?: boolean;
}

export interface TicketValues {
  ticketNumber?: string;
  ticketDate?: string;
  ticketQuantity?: number;
  submittedAt?: string;
}

export interface TicketTrip {
  tripUuid: string;
  status: string;
  ticketUuid: string | null;
  ticketNumber: string | null;
  ticketDate: string | null;
  ticketQuantity: number | null;
  ticketStatus: string | null;
  ocrTicketNumber: string | null;
  ocrTicketDate: string | null;
  ocrTicketQuantity: number | null;
  ocrError: string | null;
  ticketSubmittedAt: string | null;
  ticketReceivedAt: string | null;
  canSubmitTicket: boolean;
}

export interface SubmitSyncOperation extends SyncOperation {
  submittedAt?: string;
}

/**
 * QC-873: the Drivers API ticket routes (upload to the Drivers S3, OCR status, reprocess, Submit), the location pings
 * with TripGpsUUID / HostUUID / isManual, POST /sync operations and GET /me, for a driver signed in by password grant.
 */
export class DriverTicketSubmitApi extends DriverEventsApi {
  constructor(
    private readonly http: APIRequestContext,
    private readonly bearer: string,
  ) {
    super(http, bearer);
  }

  upload(tripUuid: string, file: TicketFile, options: { ticketUuid?: string; sha256?: string } = {}): Promise<APIResponse> {
    const headers = this.auth();
    if (options.sha256 !== undefined) headers[CONTENT_HASH_HEADER] = options.sha256;
    const multipart: Record<string, string | TicketFile> = { file };
    if (options.ticketUuid !== undefined) multipart.TicketUUID = options.ticketUuid;
    return this.http.post(`${baseUrl()}/driver-trip-ticket/upload/${tripUuid}`, { headers, multipart, timeout: 60_000 });
  }

  submit(tripUuid: string, values: TicketValues, key?: string): Promise<APIResponse> {
    const headers = this.auth();
    if (key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = key;
    return this.http.post(`${baseUrl()}/driver-trip-ticket/submit/${tripUuid}`, { headers, data: values });
  }

  reprocess(tripUuid: string): Promise<APIResponse> {
    return this.http.post(`${baseUrl()}/driver-trip-ticket/reprocess/${tripUuid}`, { headers: this.auth() });
  }

  ticketStatus(tripUuid: string): Promise<APIResponse> {
    return this.http.get(`${baseUrl()}/driver-trip-ticket/status/${tripUuid}`, { headers: this.auth() });
  }

  async ticketTrip(tripUuid: string): Promise<TicketTrip> {
    const response = await this.ticketStatus(tripUuid);
    if (response.status() !== 200) throw new Error(`GET driver-trip-ticket/status answered ${response.status()}: ${await response.text()}`);
    return (await response.json()).data as TicketTrip;
  }

  gpsPings(pings: GpsPing[], deviceId: string, hostUuid?: string): Promise<APIResponse> {
    return this.http.post(`${baseUrl()}/driver-location/pings`, {
      headers: { ...this.auth(), 'X-Device-Id': deviceId },
      data: hostUuid === undefined ? { pings } : { HostUUID: hostUuid, pings },
    });
  }

  async syncOperations(operations: SubmitSyncOperation[]): Promise<SyncOperationResult[]> {
    const response = await this.http.post(`${baseUrl()}/sync`, { headers: this.auth(), data: { operations } });
    if (response.status() !== 200) throw new Error(`POST /sync answered ${response.status()}: ${await response.text()}`);
    return ((await response.json()).data as { results: SyncOperationResult[] }).results;
  }

  me(hostUuid?: string): Promise<APIResponse> {
    const headers = this.auth();
    if (hostUuid !== undefined) headers[HOST_HEADER] = hostUuid;
    return this.http.get(`${baseUrl()}/me`, { headers });
  }

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.bearer}` };
  }
}

export function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function baseUrl(): string {
  if (!env.driversApiUrl) throw new Error('DRIVERS_API_URL is not set.');
  return env.driversApiUrl;
}
