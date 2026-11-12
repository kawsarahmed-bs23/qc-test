import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';

export interface HostAnswer<T = unknown> {
  status: number;
  data: T | null;
  message: string | null;
  text: string;
}

export interface HostLogin {
  accessToken: string;
  refreshToken: string;
  refreshTokenExpiredAt: string;
}

export interface DispatchContactSetting {
  isDispatchContact: boolean;
  dispatchContactName: string | null;
}

export interface VendorAssignOption {
  vendorId: number;
  vendorName: string | null;
  dispatchContactUserId?: string | null;
  dispatchContactName?: string | null;
  dispatchContactPhoneNumber?: string | null;
}

export interface SmsPreviewAnswer {
  body: string | null;
  phoneNumber: string | null;
  canSend: boolean;
  cannotSendReason: string | null;
}

export interface VendorOnlyAssignment {
  orderId: number;
  assignmentDate: string;
  vendorId: number;
  sendSms?: boolean;
  notes: string;
}

export type UserEditArea = 'manageusers' | 'vendor';

/**
 * QC-910 host API calls, signed in through the host's own `api/account/login`: the user-edit models with
 * `isDispatchContact` / `showIsDispatchContact`, the Vendor Portal `api/vendor/settings/dispatch-contact` setting, the Edit
 * Vendor / Edit Truck models (`dispatchContactName`, `availableUserOrganisations`), the assign options, the SMS preview and
 * a Vendor-only (no truck, no driver) assignment save.
 */
export class DispatchContactApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  /** Signs in and returns the login answer, which the browser session stores the way the app does. */
  async signIn(email: string, password: string): Promise<HostLogin> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() !== 200) {
      throw new Error(`api/account/login for ${email} answered ${response.status()}`);
    }
    const login = (await response.json()).data as HostLogin;
    this.accessToken = login.accessToken;
    return login;
  }

  userEdit(area: UserEditArea, userId: string): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/${area}/user-edit/${encodeURIComponent(userId)}`);
  }

  saveUserEdit(area: UserEditArea, model: Record<string, unknown>): Promise<HostAnswer<Record<string, unknown>>> {
    return this.post(`/api/${area}/user-edit`, model);
  }

  vendorEdit(vendorId: number): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/organisation/vendor-edit/${vendorId}`);
  }

  truckEdit(truckId: number): Promise<HostAnswer<Record<string, unknown>>> {
    return this.get(`/api/organisation/truck-edit/${truckId}`);
  }

  dispatchContactSetting(): Promise<HostAnswer<DispatchContactSetting>> {
    return this.get('/api/vendor/settings/dispatch-contact');
  }

  saveDispatchContactSetting(isDispatchContact: boolean): Promise<HostAnswer<DispatchContactSetting>> {
    return this.post('/api/vendor/settings/dispatch-contact', { isDispatchContact });
  }

  async assignVendor(vendorId: number): Promise<VendorAssignOption | null> {
    const answer = await this.get<{ vendors: VendorAssignOption[] }>('/api/dispatch/assign-options');
    if (answer.status !== 200) throw new Error(`GET assign-options answered ${answer.status}: ${answer.text}`);
    return answer.data?.vendors.find((v) => v.vendorId === vendorId) ?? null;
  }

  async smsPreview(orderId: number, vendorId: number): Promise<HostAnswer<SmsPreviewAnswer>> {
    const query = new URLSearchParams({
      orderId: String(orderId),
      vendorId: String(vendorId),
      fulfillmentType: '10',
      timeWindowStart: '06:00:00',
      loadsAssigned: '2',
    });
    return this.get(`/api/dispatch/sms-preview?${query}`);
  }

  saveVendorOnlyAssignment(assignment: VendorOnlyAssignment): Promise<HostAnswer<number>> {
    return this.post(`/api/order/${assignment.orderId}/assignment`, vendorOnlyBody(assignment));
  }

  /** Saves an existing assignment again as Vendor-only (PUT api/assignment/{id}), the way the Assign Truck dialog's edit does. */
  updateVendorOnlyAssignment(orderAssignmentId: number, assignment: VendorOnlyAssignment): Promise<HostAnswer<number>> {
    return this.put(`/api/assignment/${orderAssignmentId}`, { ...vendorOnlyBody(assignment), orderAssignmentId });
  }

  protected async get<T>(path: string): Promise<HostAnswer<T>> {
    return read(await this.request.get(`${hostApiUrl()}${path}`, { headers: this.headers(), ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  protected async put<T>(path: string, data: unknown): Promise<HostAnswer<T>> {
    return read(await this.request.put(`${hostApiUrl()}${path}`, { headers: this.headers(), data, ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  protected async post<T>(path: string, data: unknown): Promise<HostAnswer<T>> {
    return read(await this.request.post(`${hostApiUrl()}${path}`, { headers: this.headers(), data, ignoreHTTPSErrors: env.ignoreHttpsErrors }));
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

function vendorOnlyBody(assignment: VendorOnlyAssignment): Record<string, unknown> {
  return {
    orderId: assignment.orderId,
    assignmentDate: assignment.assignmentDate,
    vendorId: assignment.vendorId,
    truckId: null,
    driverUserId: null,
    truckCount: 1,
    timeWindowStart: '06:00:00',
    timeWindowEnd: '18:00:00',
    loadsAssigned: 2,
    fulfillmentType: 'fixed',
    notes: assignment.notes,
    sendSms: assignment.sendSms ?? false,
    smsBody: null,
    histories: [],
  };
}

async function read<T>(response: import('@playwright/test').APIResponse): Promise<HostAnswer<T>> {
  const text = await response.text();
  let data: T | null = null;
  let message: string | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    data = (parsed?.data ?? null) as T | null;
    message = typeof parsed?.message === 'string' ? parsed.message : null;
  } catch {
    data = null;
  }
  return { status: response.status(), data, message, text };
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
