import * as fs from 'fs';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { HOST_HEADER, type MirrorAssignment, type MirrorMessage, type MirrorTrip } from '@api/drivers-mirror.api';

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

  sync(since?: string | null, hostHeader: string | null = null): Promise<APIResponse> {
    return this.request.get(`${baseUrl()}/sync`, {
      headers: this.headers(hostHeader),
      params: since === undefined || since === null ? undefined : { since },
    });
  }

  async changes(since?: string | null, hostHeader: string | null = null): Promise<SyncPayload> {
    const response = await this.sync(since, hostHeader);
    if (response.status() !== 200) {
      throw new Error(`GET /sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as SyncPayload;
  }

  push(operations: SyncOperation[], since?: string | null): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/sync`, {
      headers: this.headers(),
      data: since === undefined ? { operations } : { since, operations },
    });
  }

  async apply(operations: SyncOperation[], since?: string | null): Promise<{ results: SyncOperationResult[]; changes: SyncPayload }> {
    const response = await this.push(operations, since);
    if (response.status() !== 200) {
      throw new Error(`POST /sync answered ${response.status()}: ${await response.text()}`);
    }
    return (await response.json()).data as { results: SyncOperationResult[]; changes: SyncPayload };
  }

  accept(orderAssignmentUuid: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-assignment/accept-assignment/${orderAssignmentUuid}`, { headers: this.headers(null, key) });
  }

  beginHaul(orderAssignmentUuid: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver/assignments/${orderAssignmentUuid}/begin-haul`, {
      headers: this.headers(null, key),
      data: { isOfflineSync: false },
    });
  }

  sendMessage(orderAssignmentUuid: string, messageBody: string, key?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-message/send`, {
      headers: this.headers(null, key),
      data: { orderAssignmentUuid, messageBody },
    });
  }

  endHaul(tripUuid: string, key?: string): Promise<APIResponse> {
    return this.request.put(`${baseUrl()}/driver/trips/${tripUuid}/end-haul`, {
      headers: this.headers(null, key),
      data: { isOfflineSync: false },
    });
  }

  uploadTicket(tripUuid: string, file: TicketFile, options: { key?: string; sha256?: string } = {}): Promise<APIResponse> {
    const headers = this.headers(null, options.key);
    if (options.sha256 !== undefined) headers[CONTENT_HASH_HEADER] = options.sha256;
    return this.request.post(`${baseUrl()}/driver-trip-ticket/upload/${tripUuid}`, { headers, multipart: { file }, timeout: 60_000 });
  }

  ticketStatus(tripUuid: string): Promise<APIResponse> {
    return this.request.get(`${baseUrl()}/driver-trip-ticket/status/${tripUuid}`, { headers: this.headers() });
  }

  async trip(tripUuid: string): Promise<SyncTrip | null> {
    const response = await this.ticketStatus(tripUuid);
    return response.status() === 200 ? ((await response.json()).data as SyncTrip) : null;
  }

  registerDevice(device: DeviceRegistration): Promise<APIResponse> {
    return this.request.put(`${baseUrl()}/devices`, { headers: this.headers(), data: device });
  }

  removeDevice(deviceId: string): Promise<APIResponse> {
    return this.request.delete(`${baseUrl()}/devices/${encodeURIComponent(deviceId)}`, { headers: this.headers() });
  }

  private headers(hostHeader: string | null = null, key?: string): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (hostHeader !== null) headers[HOST_HEADER] = hostHeader;
    if (key !== undefined) headers[IDEMPOTENCY_KEY_HEADER] = key;
    return headers;
  }
}

export function isReplayed(response: APIResponse): boolean {
  return response.headers()[REPLAYED_HEADER] === 'true';
}

export function withCursor(cursor: string, change: { issuedAt?: Date; hostPrefixFrom?: string; legacyHostUuid?: string }): string {
  const bytes = Buffer.from(cursor, 'base64url');
  if (change.issuedAt) bytes.writeBigInt64BE(BigInt(Math.floor(change.issuedAt.getTime() / 1000)), 8);
  if (change.hostPrefixFrom) Buffer.from(change.hostPrefixFrom, 'base64url').copy(bytes, 16, 16, 24);
  if (change.legacyHostUuid) dotNetGuidBytes(change.legacyHostUuid).copy(bytes, 16, 0, 8);
  return bytes.toString('base64url');
}

/** A Guid's bytes as .NET's Guid.ToByteArray() lays them out: the first three groups little-endian, the rest as written. */
export function dotNetGuidBytes(uuid: string): Buffer {
  const hex = Buffer.from(uuid.replace(/-/g, ''), 'hex');
  return Buffer.concat([
    Buffer.from(hex.subarray(0, 4)).reverse(),
    Buffer.from(hex.subarray(4, 6)).reverse(),
    Buffer.from(hex.subarray(6, 8)).reverse(),
    hex.subarray(8),
  ]);
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
