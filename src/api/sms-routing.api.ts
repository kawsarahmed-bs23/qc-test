import { DispatchContactApi, type HostAnswer, type SmsPreviewAnswer } from './dispatch-contact.api';

export interface DriverAssignment {
  orderId: number;
  assignmentDate: string;
  vendorId: number;
  truckId: number;
  driverUserId: string;
  notes: string;
  smsBody?: string | null;
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
    smsBody: assignment.smsBody ?? null,
    histories: [],
  };
}
