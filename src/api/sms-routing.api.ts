import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';
import { serviceToken } from '@api/identity-admin.api';
import { querySingleValue } from '@utils/localDb';
import { DispatchContactApi, type HostAnswer, type SmsPreviewAnswer } from './dispatch-contact.api';

export const DRIVERS_MODE_KEY = 'Drivers:Mode';
export type DriversMode = 'Off' | 'On';

export interface DriverAssignment {
  orderId: number;
  assignmentDate: string;
  vendorId: number;
  truckId: number;
  driverUserId: string;
  notes: string;
  smsBody?: string | null;
  sendSms?: boolean;
}

export interface CopyAnswer {
  created?: number;
  createdAssignmentIds?: number[];
  notificationsSent?: number;
  notificationsSkipped?: number;
  notificationFailures?: string[];
}

export interface CommsSendAnswer {
  messageId?: number;
  orderAssignmentId?: number | null;
}

export interface CommsThreadAnswer {
  canSend: boolean;
  cannotSendReason: string | null;
  canSendSms: boolean;
  canSendInApp: boolean;
}

/**
 * QC-930 host API calls, signed in through the host's own `api/account/login`: a driver assignment save with no `sendSms`
 * (the tick is retired; every save that makes an offer sends it), an edit of one, the driver SMS preview with `delivery`,
 * a copy with "Notify drivers now", and the Messages page send and thread.
 */
export class SmsRoutingApi extends DispatchContactApi {
  saveDriverAssignment(assignment: DriverAssignment): Promise<HostAnswer<number>> {
    return this.post(`/api/order/${assignment.orderId}/assignment`, driverBody(assignment));
  }

  updateDriverAssignment(orderAssignmentId: number, assignment: DriverAssignment): Promise<HostAnswer<number>> {
    return this.put(`/api/assignment/${orderAssignmentId}`, { ...driverBody(assignment), orderAssignmentId });
  }

  driverSmsPreview(orderId: number, vendorId: number, driverUserId: string): Promise<HostAnswer<SmsPreviewAnswer>> {
    const query = new URLSearchParams({
      orderId: String(orderId),
      vendorId: String(vendorId),
      driverUserId,
      fulfillmentType: '10',
      timeWindowStart: '06:00:00',
      loadsAssigned: '2',
    });
    return this.get(`/api/dispatch/sms-preview?${query}`);
  }

  copyAndNotify(sourceDate: string, orderAssignmentIds: number[], targetDates: string[]): Promise<HostAnswer<CopyAnswer>> {
    return this.post('/api/assignment/copy', { sourceDate, orderAssignmentIds, targetDates, extendOrderIds: [], notifyDrivers: true });
  }

  commsSend(driverUserId: string, messageBody: string, channel: 'sms' | 'in-app'): Promise<HostAnswer<CommsSendAnswer>> {
    return this.post('/api/dispatch/messages/send', { driverUserId, orderAssignmentId: null, messageBody, channel });
  }

  commsThread(driverUserId: string): Promise<HostAnswer<CommsThreadAnswer>> {
    return this.get(`/api/dispatch/messages/threads/${encodeURIComponent(driverUserId)}`);
  }
}

/**
 * The host's Drivers:Mode (QC-930): Off keeps the host texting its own Drivers with the Send SMS tick, On hands Drivers who
 * accepted an invite to the Drivers API. It is changed through the host API's PUT api/environment-setting with the Admin service
 * client's token, which reloads the host configuration; a direct change to app.EnvironmentSetting is not read until a restart.
 */
export class HostDriversMode {
  constructor(private readonly request: APIRequestContext) {}

  current(): DriversMode | null {
    const value = querySingleValue(
      `SELECT PropertyValue FROM app.EnvironmentSetting WHERE GroupName = 'Drivers' AND SubGroupName IS NULL AND PropertyName = 'Mode'`,
    );
    return value === 'On' || value === 'Off' ? value : null;
  }

  async set(mode: DriversMode): Promise<void> {
    if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
    const token = await serviceToken(this.request, 'quarryconnect.api');
    if (token.status !== 200 || !token.body.access_token) {
      throw new Error(`The Admin service client could not get a host API token: ${token.status} ${JSON.stringify(token.body)}`);
    }
    const headers = { Authorization: `Bearer ${token.body.access_token as string}` };
    const listed = await this.request.get(`${env.appApiUrl}/api/environment-setting`, { headers });
    if (listed.status() !== 200) throw new Error(`GET api/environment-setting answered ${listed.status()}: ${await listed.text()}`);
    const body = (await listed.json()) as
      | { settings: { environmentSettingId: number; configurationKey: string }[] }[]
      | { data: { settings: { environmentSettingId: number; configurationKey: string }[] }[] };
    const groups = Array.isArray(body) ? body : body.data;
    const setting = groups.flatMap((group) => group.settings).find((s) => s.configurationKey === DRIVERS_MODE_KEY);
    if (!setting) throw new Error(`The host has no ${DRIVERS_MODE_KEY} setting; apply host/up/202611121930_QC-930_Drivers_Mode.sql.`);
    const saved = await this.request.put(`${env.appApiUrl}/api/environment-setting`, {
      headers,
      data: { settings: [{ environmentSettingId: setting.environmentSettingId, value: mode }] },
    });
    if (saved.status() !== 200) throw new Error(`PUT api/environment-setting ${DRIVERS_MODE_KEY}=${mode} answered ${saved.status()}: ${await saved.text()}`);
  }
}

function driverBody(assignment: DriverAssignment): Record<string, unknown> {
  return {
    orderId: assignment.orderId,
    assignmentDate: assignment.assignmentDate,
    vendorId: assignment.vendorId,
    truckId: assignment.truckId,
    driverUserId: assignment.driverUserId,
    truckCount: 1,
    timeWindowStart: '06:00:00',
    timeWindowEnd: '18:00:00',
    loadsAssigned: 2,
    fulfillmentType: 'fixed',
    notes: assignment.notes,
    sendSms: assignment.sendSms ?? false,
    smsBody: assignment.smsBody ?? null,
    histories: [],
  };
}
