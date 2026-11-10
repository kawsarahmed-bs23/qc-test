import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { CONTENT_HASH_HEADER, IDEMPOTENCY_KEY_HEADER, type SyncOperationType, type TicketFile } from '@api/driver-sync.api';

export type HostSyncOperationStatus = 'sent' | 'duplicate' | 'invalid' | 'not-found' | 'conflict' | 'failed';

export interface HostSyncOperation {
  key?: string | null;
  type: SyncOperationType | string;
  targetId?: number | null;
  notes?: string;
  deviceAt?: string;
  isOfflineSync?: boolean;
  messageBody?: string;
  replyToMessageId?: number;
  ticketNumber?: string;
  ticketDate?: string;
  ticketQuantity?: number;
}

export interface HostSyncOperationResult {
  key: string | null;
  type: string | null;
  status: HostSyncOperationStatus;
  error: string | null;
  targetId: number | null;
}

export interface HostSyncAssignment {
  orderAssignmentId: number;
  status: string;
  completedTripCount: number;
  notes: string | null;
  openTrip: HostSyncTrip | null;
}

export interface HostSyncTrip {
  tripId: number;
  orderAssignmentId: number;
  tripSequence: number;
  status: string;
  ticketId: number | null;
}

export interface HostSyncMessage {
  messageId: number;
  orderAssignmentId: number | null;
  isFromDispatch: boolean;
  messageBody: string;
  seenByDriverAt: string | null;
}

export interface HostSyncPayload {
  cursor: string;
  reset: boolean;
  assignments: HostSyncAssignment[];
  trips: HostSyncTrip[];
  messages: HostSyncMessage[];
  deleted: { type: string; id: number; uuid: string }[];
}

export class HostDriverSyncApi {
  private constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  static async signIn(request: APIRequestContext, email: string, password: string): Promise<HostDriverSyncApi> {
    const response = await request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password } });
    if (response.status() !== 200) {
      throw new Error(`host sign-in for ${email} answered ${response.status()}: ${await response.text()}`);
    }
    return new HostDriverSyncApi(request, (await response.json()).data.accessToken as string);
  }

  sync(since?: string | null): Promise<APIResponse> {
    return this.request.get(`${hostApiUrl()}/api/driver-sync`, {
      headers: this.headers(),
      params: since === undefined || since === null ? undefined : { since },
    });
  }

  async changes(since?: string | null): Promise<HostSyncPayload> {
    const response = await this.sync(since);
    if (response.status() !== 200) {
      throw new Error(`GET api/driver-sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as HostSyncPayload;
  }

  push(operations: HostSyncOperation[], since?: string | null): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/driver-sync`, {
      headers: this.headers(),
      data: since === undefined ? { operations } : { since, operations },
    });
  }

  async apply(operations: HostSyncOperation[], since?: string | null): Promise<{ results: HostSyncOperationResult[]; changes: HostSyncPayload }> {
    const response = await this.push(operations, since);
    if (response.status() !== 200) {
      throw new Error(`POST api/driver-sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as { results: HostSyncOperationResult[]; changes: HostSyncPayload };
  }

  accept(orderAssignmentId: number, key?: string): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/driver-assignment/accept-assignment/${orderAssignmentId}`, { headers: this.headers(key) });
  }

  endHaul(tripId: number, key?: string): Promise<APIResponse> {
    return this.request.put(`${hostApiUrl()}/api/driver/trips/${tripId}/end-haul`, { headers: this.headers(key), data: { isOfflineSync: false } });
  }

  sendMessage(orderAssignmentId: number, messageBody: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/driver-message/send`, { headers: this.headers(key), data: { orderAssignmentId, messageBody } });
  }

  markSeen(orderAssignmentId: number, key?: string): Promise<APIResponse> {
    return this.request.put(`${hostApiUrl()}/api/driver-message/threads/${orderAssignmentId}/seen`, { headers: this.headers(key) });
  }

  uploadTicket(tripId: number, file: TicketFile, options: { key?: string; sha256?: string } = {}): Promise<APIResponse> {
    const headers = this.headers(options.key);
    if (options.sha256 !== undefined) headers[CONTENT_HASH_HEADER] = options.sha256;
    return this.request.post(`${hostApiUrl()}/api/driver-trip-ticket/upload/${tripId}`, { headers, multipart: { file }, timeout: 120_000 });
  }

  private headers(key?: string): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = key;
    return headers;
  }
}

function hostApiUrl(): string {
  if (!env.appApiUrl) {
    throw new Error('APP_API_URL is not set.');
  }
  return env.appApiUrl;
}
