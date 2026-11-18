import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';

/**
 * QC-998: the host API edits whose effect now reaches DRIVERS by message: an order save (JobChanged), a ticket edit
 * (TicketAdjusted) and removing a duplicate ticket (TicketRejected). Signed in through the host's own api/account/login.
 */
export class HostChangeSyncApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() === 200) {
      this.accessToken = (await response.json()).data.accessToken as string;
    }
    return response.status();
  }

  async order(orderId: number): Promise<Record<string, unknown>> {
    const response = await this.request.get(`${hostApiUrl()}/api/order/${orderId}`, { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() !== 200) throw new Error(`GET api/order/${orderId} answered ${response.status()}: ${await response.text()}`);
    return (await response.json()).data as Record<string, unknown>;
  }

  saveOrder(orderId: number, order: Record<string, unknown>): Promise<APIResponse> {
    return this.request.put(`${hostApiUrl()}/api/order/${orderId}`, { headers: this.headers(), data: order, ignoreHTTPSErrors: env.ignoreHttpsErrors });
  }

  updateTicket(ticket: { ticketId: number; ticketNumber: string; ticketDate: string; ticketQuantity: number; jobCode: string }): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/ticket/update`, {
      headers: this.headers(),
      multipart: {
        TicketId: String(ticket.ticketId),
        TicketNumber: ticket.ticketNumber,
        TicketDate: ticket.ticketDate,
        TicketQuantity: String(ticket.ticketQuantity),
        JobCode: ticket.jobCode,
      },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  removeDuplicateTicket(ticketId: number): Promise<APIResponse> {
    return this.request.post(`${hostApiUrl()}/api/ticket/remove-duplicate-ticket/${ticketId}`, {
      headers: this.headers(),
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
