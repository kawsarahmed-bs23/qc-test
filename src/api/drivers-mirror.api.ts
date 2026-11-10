import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';

export const HOST_HEADER = 'X-Host-Uuid';

export interface MirrorAssignment {
  HostUUID: string;
  HostName?: string | null;
  VendorUUID?: string | null;
  VendorName?: string | null;
  TruckUUID?: string | null;
  TruckName?: string | null;
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
  HostUUID?: string;
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
  HostUUID?: string;
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
  threads: { HostUUID: string; HostName: string | null; orderAssignmentUuid: string; unseenCount: number; messageCount: number }[];
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

  myAssignments(range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromAssignmentDate = range.from;
    if (range.to) data.searchToAssignmentDate = range.to;
    return this.send({ method: 'POST', path: '/driver-assignment/my-assignments', data });
  }

  async assignments(range: { from?: string; to?: string } = {}): Promise<MirrorAssignment[]> {
    const response = await this.myAssignments(range);
    if (response.status() !== 200) {
      throw new Error(`my-assignments answered ${response.status()}`);
    }
    return (await response.json()).data.data as MirrorAssignment[];
  }

  details(orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send({ method: 'GET', path: `/driver-assignment/details/${orderAssignmentUuid}` });
  }

  async assignment(orderAssignmentUuid: string): Promise<MirrorAssignment | null> {
    const response = await this.details(orderAssignmentUuid);
    return response.status() === 200 ? ((await response.json()).data as MirrorAssignment) : null;
  }

  accept(orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver-assignment/accept-assignment/${orderAssignmentUuid}` });
  }

  beginHaul(orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver/assignments/${orderAssignmentUuid}/begin-haul`, data: { isOfflineSync: false } });
  }

  endHaul(tripUuid: string): Promise<APIResponse> {
    return this.send({ method: 'PUT', path: `/driver/trips/${tripUuid}/end-haul`, data: { isOfflineSync: false } });
  }

  myTickets(range: { from?: string; to?: string } = {}): Promise<APIResponse> {
    const data: Record<string, string> = {};
    if (range.from) data.searchFromTicketDate = range.from;
    if (range.to) data.searchToTicketDate = range.to;
    return this.send({ method: 'POST', path: '/driver-trip-ticket/my-tickets', data });
  }

  reject(orderAssignmentUuid: string, note: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver-assignment/reject-assignment/${orderAssignmentUuid}`, data: { note } });
  }

  reopenHaul(tripUuid: string): Promise<APIResponse> {
    return this.send({ method: 'PUT', path: `/driver/trips/${tripUuid}/reopen-haul` });
  }

  reportProblem(tripUuid: string, notes: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver/trips/${tripUuid}/report-problem`, data: { notes } });
  }

  finishDay(orderAssignmentUuid: string, notes?: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver/assignments/${orderAssignmentUuid}/finish-day`, data: { notes, isOfflineSync: false } });
  }

  reprocessTicket(tripUuid: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver-trip-ticket/reprocess/${tripUuid}` });
  }

  reviewTicket(tripUuid: string, review: { ticketNumber?: string; ticketDate?: string | null; ticketQuantity?: number }): Promise<APIResponse> {
    return this.send({ method: 'POST', path: `/driver-trip-ticket/review/${tripUuid}`, data: review });
  }

  uploadTicket(tripUuid: string, file: { name: string; mimeType: string; buffer: Buffer }): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-trip-ticket/upload/${tripUuid}`, {
      headers: this.headers(),
      multipart: { file },
      timeout: 60_000,
    });
  }

  threads(): Promise<APIResponse> {
    return this.send({ method: 'GET', path: '/driver-message/threads' });
  }

  async threadList(): Promise<MirrorThreadList> {
    const response = await this.threads();
    if (response.status() !== 200) {
      throw new Error(`threads answered ${response.status()}`);
    }
    return (await response.json()).data as MirrorThreadList;
  }

  thread(orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send({ method: 'GET', path: `/driver-message/threads/${orderAssignmentUuid}` });
  }

  sendMessage(orderAssignmentUuid: string, messageBody: string): Promise<APIResponse> {
    return this.send({ method: 'POST', path: '/driver-message/send', data: { orderAssignmentUuid, messageBody } });
  }

  markSeen(orderAssignmentUuid: string): Promise<APIResponse> {
    return this.send({ method: 'PUT', path: `/driver-message/threads/${orderAssignmentUuid}/seen` });
  }

  quickReplies(hostUuid: string | null): Promise<APIResponse> {
    const query = hostUuid === null ? '' : `?HostUUID=${encodeURIComponent(hostUuid)}`;
    return this.send({ method: 'GET', path: `/driver-message/quick-replies${query}` });
  }

  pings(pings: LocationPing[], deviceId: string, hostUuid?: string): Promise<APIResponse> {
    return this.request.post(`${baseUrl()}/driver-location/pings`, {
      headers: { ...this.headers(), 'X-Device-Id': deviceId },
      data: hostUuid === undefined ? { pings } : { HostUUID: hostUuid, pings },
    });
  }

  send(route: DriverWorkRoute, hostHeader: string | null = null): Promise<APIResponse> {
    return this.request.fetch(`${baseUrl()}${route.path}`, {
      method: route.method,
      headers: this.headers(hostHeader),
      data: route.data,
    });
  }

  private headers(hostHeader: string | null = null): Record<string, string> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.accessToken}` };
    if (hostHeader !== null) headers[HOST_HEADER] = hostHeader;
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

  voidOrder(orderId: number): Promise<APIResponse> {
    return this.request.delete(`${hostApiUrl()}/api/order/${orderId}`, { headers: this.headers() });
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
