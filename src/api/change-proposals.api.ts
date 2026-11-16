import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { type HostAnswer, type UserEditArea } from '@api/dispatch-contact.api';
import { NotifyBySmsApi } from '@api/notify-by-sms.api';
import { type DriversResult } from '@api/driver-settings.api';

export type ChangeAnswerValue = 'approved' | 'declined';

export interface CommsChange {
  changeUuid: string;
  kind: 'user-details' | 'truck-number' | 'driver-truck-number';
  direction: 'sent' | 'received';
  status: 'pending' | 'approved' | 'declined' | 'superseded';
  firstName: string | null;
  lastName: string | null;
  mobilePhone: string | null;
  notifyBySms: boolean | null;
  truckNumber: string | null;
  previousTruckNumber: string | null;
  answeredByName: string | null;
  answerComment: string | null;
  canAnswer: boolean;
}

export interface CommsMessage {
  messageId: number;
  messageBody: string;
  isActioned?: boolean;
  change?: CommsChange | null;
}

export interface CommsThread {
  driverUserId: string;
  messages: CommsMessage[];
}

export interface CommsQueueItem {
  messageId: number;
  driverUserId: string;
  messageBody: string;
  change?: CommsChange | null;
}

export interface DriverChangeProposal {
  changeUuid: string;
  hostUuid: string;
  hostName: string | null;
  kind: 'user-details' | 'truck-number' | 'driver-truck-number';
  direction: 'received' | 'sent';
  status: 'pending' | 'approved' | 'declined' | 'superseded';
  firstName: string | null;
  lastName: string | null;
  mobilePhone: string | null;
  notifyBySms: boolean | null;
  truckNumber: string | null;
  previousTruckNumber: string | null;
  changedByName: string | null;
  changedAt: string | null;
  answeredAt: string | null;
  answeredByName: string | null;
  answerComment: string | null;
}

export interface DriverChangeList {
  changes: DriverChangeProposal[];
}

/**
 * QC-933 host API calls on top of the user-edit ones: the Edit Truck save of Manage Trucks and of the Vendor Portal, the Comms
 * thread and queue with their `change` block, and the Approve / Decline answer of a change a Driver proposed
 * (`PUT api/dispatch/messages/{messageId}/change`).
 */
export class ChangeProposalsApi extends NotifyBySmsApi {
  /** Posts the user-edit model the app loaded with `changes` on top, the way the Edit User form saves. */
  async editUser(area: UserEditArea, userId: string, changes: Record<string, unknown> = {}): Promise<HostAnswer<Record<string, unknown>>> {
    const model = await this.userEdit(area, userId);
    if (model.status !== 200) throw new Error(`GET ${area} user-edit answered ${model.status}: ${model.text}`);
    return this.saveUserEdit(area, { ...model.data, ...changes, password: null, confirmPassword: null });
  }

  truckEditModel(area: 'organisation' | 'vendor', truckId: number): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/${area}/truck-edit/${truckId}`);
  }

  saveTruckEdit(area: 'organisation' | 'vendor', model: Record<string, unknown>): Promise<HostAnswer<Record<string, unknown>>> {
    return this.post(`/api/${area}/truck-edit`, model);
  }

  /** Saves a truck with a new number the way the Edit Truck form does; Manage Trucks also needs a location, so a blank one is filled. */
  async editTruckNumber(area: 'organisation' | 'vendor', truckId: number, truckNumber: string): Promise<HostAnswer<Record<string, unknown>>> {
    const model = await this.truckEditModel(area, truckId);
    if (model.status !== 200) throw new Error(`GET ${area} truck-edit answered ${model.status}: ${model.text}`);
    const body: Record<string, unknown> = { ...model.data, truckNumber };
    if (area === 'organisation') {
      const location = (model.data?.location ?? {}) as Record<string, unknown>;
      body.location = {
        ...location,
        organisationLocationName: location.organisationLocationName || 'E2E QC-933 Yard',
        organisationLocationAddr1: location.organisationLocationAddr1 || '933 Congress Ave',
        organisationLocationCity: location.organisationLocationCity || 'Austin',
        organisationLocationState: location.organisationLocationState || 'TX',
        organisationLocationZip: location.organisationLocationZip || '78701',
      };
    }
    return this.saveTruckEdit(area, body);
  }

  thread(driverUserId: string, date: string): Promise<HostAnswer<CommsThread>> {
    return this.get(`/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}?date=${date}`);
  }

  queue(date: string): Promise<HostAnswer<CommsQueueItem[]>> {
    return this.get(`/api/dispatch/messages/queue?date=${date}`);
  }

  answerChange(messageId: number, answer: ChangeAnswerValue | string, comment?: string): Promise<HostAnswer<CommsMessage>> {
    return this.put(`/api/dispatch/messages/${messageId}/change`, { answer, comment: comment ?? null });
  }
}

/** QC-933 Drivers API calls the Driver App would make: the pending / all change proposals and the answer to one. */
export class DriverChangesApi {
  constructor(private readonly request: APIRequestContext) {}

  list(accessToken: string, status: 'pending' | 'all' = 'pending'): Promise<DriversResult<DriverChangeList>> {
    return this.read(this.request.get(`${baseUrl()}/me/change-proposals?status=${status}`, { headers: headers(accessToken) }));
  }

  answer(
    accessToken: string,
    changeUuid: string,
    answer: ChangeAnswerValue | string,
    comment?: string,
    idempotencyKey?: string,
  ): Promise<DriversResult<DriverChangeProposal>> {
    return this.read(
      this.request.post(`${baseUrl()}/me/change-proposals/${changeUuid}/answer`, {
        headers: { ...headers(accessToken), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
        data: { answer, comment: comment ?? null },
      }),
    );
  }

  saveTruckNumber(accessToken: string, truckNumber: string): Promise<DriversResult<{ TruckNumber: string | null }>> {
    return this.read(this.request.put(`${baseUrl()}/me/settings`, { headers: headers(accessToken), data: { TruckNumber: truckNumber } }));
  }

  settings(accessToken: string): Promise<DriversResult<{ TruckNumber: string | null; NotifyBySms?: boolean | null }>> {
    return this.read(this.request.get(`${baseUrl()}/me/settings`, { headers: headers(accessToken) }));
  }

  private async read<T>(pending: Promise<APIResponse>): Promise<DriversResult<T>> {
    const response = await pending;
    const text = await response.text();
    let body: DriversResult<T>['body'] = {};
    try {
      body = text ? (JSON.parse(text) as DriversResult<T>['body']) : {};
    } catch {
      body = { message: text };
    }
    return { status: response.status(), body };
  }
}

function headers(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

function baseUrl(): string {
  if (!env.driversApiUrl) throw new Error('DRIVERS_API_URL is not set.');
  return env.driversApiUrl;
}
