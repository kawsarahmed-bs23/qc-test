import * as fs from 'fs';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/environment';
import { HOST_HEADER, type MirrorAssignment, type MirrorMessage, type MirrorTrip } from './DriversMirrorApi';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'idempotent-replayed';
export const CONTENT_HASH_HEADER = 'X-Content-SHA256';

export type SyncOperationType =
  | 'accept-assignment'
  | 'reject-assignment'
  | 'begin-haul'
  | 'end-haul'
  | 'reopen-haul'
  | 'finish-day'
  | 'report-problem'
  | 'reprocess-ticket'
  | 'review-ticket'
  | 'send-message'
  | 'mark-thread-seen';

export type SyncOperationStatus = 'sent' | 'duplicate' | 'refused' | 'invalid' | 'not-found' | 'unavailable' | 'conflict' | 'failed';

export interface SyncOperation {
  key?: string | null;
  type: SyncOperationType | string;
  targetUuid?: string | null;
  notes?: string;
  deviceAt?: string;
  isOfflineSync?: boolean;
  messageBody?: string;
  replyToMessageUuid?: string;
  ticketNumber?: string;
  ticketDate?: string;
  ticketQuantity?: number;
}

export interface SyncOperationResult {
  key: string | null;
  type: string | null;
  status: SyncOperationStatus;
  error: string | null;
  targetUuid: string | null;
}

export interface SyncTrip extends MirrorTrip {
  ticketStatus: string | null;
  uploadUrl?: string | null;
}

export interface SyncPayload {
  cursor: string;
  reset: boolean;
  assignments: MirrorAssignment[];
  trips: SyncTrip[];
  messages: MirrorMessage[];
  deleted: { type: string; uuid: string }[];
}

export interface DeviceRegistration {
  token?: string;
  platform?: string;
  deviceId?: string;
}

export interface TicketFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export class DriverSyncApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  sync(hostUuid: string, since?: string | null): Promise<APIResponse> {
    return this.request.get(`${baseUrl()}/sync`, {
      headers: this.headers(hostUuid),
      params: since === undefined || since === null ? undefined : { since },
    });
  }

  async changes(hostUuid: string, since?: string | null): Promise<SyncPayload> {
    const response = await this.sync(hostUuid, since);
    if (response.status() !== 200) {
      throw new Error(`GET /sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as SyncPayload;
  }

  push(hostUuid: string, operations: SyncOperation[], since?: string | null): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/sync`, {
      headers: this.headers(hostUuid),
      data: since === undefined ? { operations } : { since, operations },
    });
  }

  async apply(hostUuid: string, operations: SyncOperation[], since?: string | null): Promise<{ results: SyncOperationResult[]; changes: SyncPayload }> {
    const response = await this.push(hostUuid, operations, since);
    if (response.status() !== 200) {
      throw new Error(`POST /sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as { results: SyncOperationResult[]; changes: SyncPayload };
  }

  accept(hostUuid: string, orderAssignmentUuid: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-assignment/accept-assignment/${orderAssignmentUuid}`, { headers: this.headers(hostUuid, key) });
  }

  sendMessage(hostUuid: string, orderAssignmentUuid: string, messageBody: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-message/send`, {
      headers: this.headers(hostUuid, key),
      data: { orderAssignmentUuid, messageBody },
    });
  }

  endHaul(hostUuid: string, tripUuid: string, key?: string): Promise<APIResponse> {
    return this.request.put(`${baseUrl()}/driver/trips/${tripUuid}/end-haul`, {
      headers: this.headers(hostUuid, key),
      data: { isOfflineSync: false },
    });
  }

  uploadTicket(hostUuid: string, tripUuid: string, file: TicketFile, options: { key?: string; sha256?: string } = {}): Promise<APIResponse> {
    const headers = this.headers(hostUuid, options.key);
    if (options.sha256 !== undefined) headers[CONTENT_HASH_HEADER] = options.sha256;
    return this.request.post(`${baseUrl()}/driver-trip-ticket/upload/${tripUuid}`, { headers, multipart: { file }, timeout: 60_000 });
  }

  ticketStatus(hostUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.request.get(`${baseUrl()}/driver-trip-ticket/status/${tripUuid}`, { headers: this.headers(hostUuid) });
  }

  async trip(hostUuid: string, tripUuid: string): Promise<SyncTrip | null> {
    const response = await this.ticketStatus(hostUuid, tripUuid);
    return response.status() === 200 ? ((await response.json()).data as SyncTrip) : null;
  }

  registerDevice(device: DeviceRegistration): Promise<APIResponse> {
    return this.request.put(`${baseUrl()}/devices`, { headers: this.headers(null), data: device });
  }

  removeDevice(deviceId: string): Promise<APIResponse> {
    return this.request.delete(`${baseUrl()}/devices/${encodeURIComponent(deviceId)}`, { headers: this.headers(null) });
  }

  private headers(hostUuid: string | null, key?: string): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (hostUuid !== null) headers[HOST_HEADER] = hostUuid;
    if (key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = key;
    return headers;
  }
}

export function isReplayed(response: APIResponse): boolean {
  return response.headers()[REPLAYED_HEADER] === 'true';
}

export function withCursor(cursor: string, change: { issuedAt?: Date; hostPrefixFrom?: string }): string {
  const bytes = Buffer.from(cursor, 'base64url');
  if (change.issuedAt) bytes.writeBigInt64BE(BigInt(Math.floor(change.issuedAt.getTime() / 1000)), 8);
  if (change.hostPrefixFrom) Buffer.from(change.hostPrefixFrom, 'base64url').copy(bytes, 16, 16, 24);
  return bytes.toString('base64url');
}

export interface ExpoStubRequest {
  at: string;
  method: string;
  url: string;
  auth: string;
  messages: Record<string, unknown>[];
}

export class ExpoStubLog {
  private constructor(private readonly file: string) {}

  static open(): ExpoStubLog | null {
    return env.expoStubLog && fs.existsSync(env.expoStubLog) ? new ExpoStubLog(env.expoStubLog) : null;
  }

  mark(): number {
    return fs.statSync(this.file).size;
  }

  since(mark: number): ExpoStubRequest[] {
    const text = fs.readFileSync(this.file).subarray(mark).toString('utf8');
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('{'))
      .map((line) => JSON.parse(line) as ExpoStubRequest)
      .filter((entry) => entry.method === 'POST');
  }

  pushesTo(mark: number, token: string): ExpoStubRequest[] {
    return this.since(mark).filter((entry) => entry.messages.some((m) => m.to === token));
  }
}

function baseUrl(): string {
  if (!env.driversApiUrl) {
    throw new Error('DRIVERS_API_URL is not set.');
  }
  return env.driversApiUrl;
}
