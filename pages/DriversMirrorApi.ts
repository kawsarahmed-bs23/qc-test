import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/environment';

export const HOST_HEADER = 'X-Host-Uuid';

export interface MirrorAssignment {
  orderAssignmentUuid: string;
  jobDocNameWithPrefix: string | null;
  origin: string | null;
  destination: string | null;
  materialName: string | null;
  assignmentDate: string;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  status: string;
  loadsAssigned: number | null;
  fulfillmentType: string | number;
  completedTripCount: number;
  openTrip: MirrorTrip | null;
  notes: string | null;
  pending: boolean;
  pendingAction: string | null;
  lastCommandError: string | null;
  trips?: MirrorTrip[];
}

export interface MirrorTrip {
  tripUuid: string;
  orderAssignmentUuid: string;
  tripSequence: number;
  status: string;
  ticketUuid: string | null;
  imageName: string | null;
  pending: boolean;
  pendingAction: string | null;
  lastCommandError: string | null;
}

export interface MirrorMessage {
  messageUuid: string;
  orderAssignmentUuid: string;
  isFromDispatch: boolean;
  messageBody: string;
  seenByDriverAt: string | null;
  pending: boolean;
  lastCommandError: string | null;
}

export interface MirrorThreadList {
  driverName: string | null;
  truckNumber: string | null;
  totalUnseenCount: number;
  threads: { orderAssignmentUuid: string; unseenCount: number; messageCount: number }[];
}

export interface DriverWorkRoute {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  data?: unknown;
}

export interface LocationPing {
  lat: number;
  lng: number;
  isMoving: boolean;
  recordedAt: string;
  accuracyMeters?: number;
  tripUuid?: string;
  orderAssignmentUuid?: string;
}

export class DriversMirrorApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  myAssignments(hostUuid: string | null, range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromAssignmentDate = range.from;
    if (range.to) data.searchToAssignmentDate = range.to;
    return this.send(hostUuid, { method: 'POST', path: '/driver-assignment/my-assignments', data });
  }

  async assignments(hostUuid: string, range: { from?: string; to?: string } = {}): Promise<MirrorAssignment[]> {
    const response = await this.myAssignments(hostUuid, range);
    if (response.status() !== 200) {
      throw new Error(`my-assignments answered ${response.status()}`);
    }
    return (await response.json()).data.data as MirrorAssignment[];
  }

  details(hostUuid: string, orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'GET', path: `/driver-assignment/details/${orderAssignmentUuid}` });
  }

  async assignment(hostUuid: string, orderAssignmentUuid: string): Promise<MirrorAssignment | null> {
    const response = await this.details(hostUuid, orderAssignmentUuid);
    return response.status() === 200 ? ((await response.json()).data as MirrorAssignment) : null;
  }

  accept(hostUuid: string, orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver-assignment/accept-assignment/${orderAssignmentUuid}` });
  }

  beginHaul(hostUuid: string, orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver/assignments/${orderAssignmentUuid}/begin-haul`, data: { isOfflineSync: false } });
  }

  endHaul(hostUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'PUT', path: `/driver/trips/${tripUuid}/end-haul`, data: { isOfflineSync: false } });
  }

  myTickets(hostUuid: string, range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromTicketDate = range.from;
    if (range.to) data.searchToTicketDate = range.to;
    return this.send(hostUuid, { method: 'POST', path: '/driver-trip-ticket/my-tickets', data });
  }

  reject(hostUuid: string, orderAssignmentUuid: string, note: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver-assignment/reject-assignment/${orderAssignmentUuid}`, data: { note } });
  }

  reopenHaul(hostUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'PUT', path: `/driver/trips/${tripUuid}/reopen-haul` });
  }

  reportProblem(hostUuid: string, tripUuid: string, notes: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver/trips/${tripUuid}/report-problem`, data: { notes } });
  }

  finishDay(hostUuid: string, orderAssignmentUuid: string, notes?: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver/assignments/${orderAssignmentUuid}/finish-day`, data: { notes, isOfflineSync: false } });
  }

  reprocessTicket(hostUuid: string, tripUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver-trip-ticket/reprocess/${tripUuid}` });
  }

  reviewTicket(hostUuid: string, tripUuid: string, review: { ticketNumber?: string; ticketDate?: string | null; ticketQuantity?: number }): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: `/driver-trip-ticket/review/${tripUuid}`, data: review });
  }

  uploadTicket(hostUuid: string, tripUuid: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-trip-ticket/upload/${tripUuid}`, {
      headers: this.headers(hostUuid),
      multipart: { file },
      timeout: 60_000,
    });
  }

  threads(hostUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'GET', path: '/driver-message/threads' });
  }

  async threadList(hostUuid: string): Promise<MirrorThreadList> {
    const response = await this.threads(hostUuid);
    if (response.status() !== 200) {
      throw new Error(`threads answered ${response.status()}`);
    }
    return (await response.json()).data as MirrorThreadList;
  }

  thread(hostUuid: string, orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'GET', path: `/driver-message/threads/${orderAssignmentUuid}` });
  }

  sendMessage(hostUuid: string, orderAssignmentUuid: string, messageBody: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'POST', path: '/driver-message/send', data: { orderAssignmentUuid, messageBody } });
  }

  markSeen(hostUuid: string, orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'PUT', path: `/driver-message/threads/${orderAssignmentUuid}/seen` });
  }

  quickReplies(hostUuid: string): Promise<APIResponse> {
    return this.send(hostUuid, { method: 'GET', path: '/driver-message/quick-replies' });
  }

  pings(hostUuid: string, pings: LocationPing[], deviceId: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-location/pings`, {
      headers: { ...this.headers(hostUuid), 'X-Device-Id': deviceId },
      data: { pings },
    });
  }

  send(hostUuid: string | null, route: DriverWorkRoute): Promise<APIResponse> {
    return this.request.fetch(`${baseUrl()}${route.path}`, {
      method: route.method,
      headers: this.headers(hostUuid),
      data: route.data,
    });
  }

  private headers(hostUuid: string | null): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (hostUuid !== null) headers[HOST_HEADER] = hostUuid;
    return headers;
  }
}

export function driverWorkRoutes(ids: { orderAssignmentUuid: string; tripUuid: string }): DriverWorkRoute[] {
  const { orderAssignmentUuid: a, tripUuid: t } = ids;
  return [
    { method: 'POST', path: '/driver-assignment/my-assignments', data: {} },
    { method: 'GET', path: `/driver-assignment/details/${a}` },
    { method: 'POST', path: `/driver-assignment/accept-assignment/${a}` },
    { method: 'POST', path: `/driver-assignment/reject-assignment/${a}`, data: { note: 'e2e-qc825' } },
    { method: 'POST', path: `/driver/assignments/${a}/begin-haul`, data: { isOfflineSync: false } },
    { method: 'PUT', path: `/driver/trips/${t}/end-haul`, data: { isOfflineSync: false } },
    { method: 'PUT', path: `/driver/trips/${t}/reopen-haul` },
    { method: 'POST', path: `/driver/assignments/${a}/finish-day`, data: { isOfflineSync: false } },
    { method: 'POST', path: `/driver/trips/${t}/report-problem`, data: { notes: 'e2e-qc825' } },
    { method: 'POST', path: '/driver-trip-ticket/my-tickets', data: {} },
    { method: 'POST', path: `/driver-trip-ticket/reprocess/${t}` },
    { method: 'POST', path: `/driver-trip-ticket/review/${t}`, data: { ticketNumber: '1', ticketDate: '2026-01-01', ticketQuantity: 1 } },
    { method: 'GET', path: '/driver-message/threads' },
    { method: 'GET', path: `/driver-message/threads/${a}` },
    { method: 'POST', path: '/driver-message/send', data: { orderAssignmentUuid: a, messageBody: 'e2e-qc825' } },
    { method: 'PUT', path: `/driver-message/threads/${a}/seen` },
    { method: 'GET', path: '/driver-message/quick-replies' },
    { method: 'POST', path: '/driver-location/pings', data: { pings: [{ lat: 30.27, lng: -97.74, isMoving: false, recordedAt: new Date().toISOString() }] } },
  ];
}

export class HostApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password } });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  driverAssignments(range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromAssignmentDate = range.from;
    if (range.to) data.searchToAssignmentDate = range.to;
    return this.request.post(`${hostApiUrl()}/api/driver-assignment/my-assignments`, { headers: this.headers(), data });
  }

  driverTickets(range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromTicketDate = range.from;
    if (range.to) data.searchToTicketDate = range.to;
    return this.request.post(`${hostApiUrl()}/api/driver-trip-ticket/my-tickets`, { headers: this.headers(), data });
  }

  quickReplies(): Promise<APIResponse> {
    return this.request.get(`${hostApiUrl()}/api/driver-message/quick-replies`, { headers: this.headers() });
  }

  sendDispatchMessage(driverUserId: string, orderAssignmentId: number, messageBody: string): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/dispatch/messages/send`, {
      headers: this.headers(),
      data: { driverUserId, orderAssignmentId, messageBody, channel: 'InApp' },
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

function baseUrl(): string {
  if (!env.driversApiUrl) {
    throw new Error('DRIVERS_API_URL is not set.');
  }
  return env.driversApiUrl;
}

function hostApiUrl(): string {
  if (!env.appApiUrl) {
    throw new Error('APP_API_URL is not set.');
  }
  return env.appApiUrl;
}
