import type { APIRequestContext } from '@playwright/test';
import { env, type ServiceClient } from '../config/environment';

export const HOST_API_SCOPE = 'quarryconnect.api';
export const UNKNOWN_USER_ID = '00000000-0000-0000-0000-000000000665';

export interface HostDriverProfile {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phoneNumber: string | null;
  isActive: boolean;
  truck: string | null;
  vendor: string | null;
}

export interface HostApiResult<T = any> {
  status: number;
  body: T;
}

export class HostDriversServiceApi {
  constructor(private readonly request: APIRequestContext) {}

  static async isReachable(request: APIRequestContext): Promise<boolean> {
    if (!env.appApiUrl) return false;
    try {
      const response = await request.get(`${env.appApiUrl}/api/drivers-service/drivers/${UNKNOWN_USER_ID}`, { timeout: 10_000 });
      return response.status() === 401;
    } catch {
      return false;
    }
  }

  async driver(userId: string, accessToken?: string): Promise<HostApiResult<{ data: HostDriverProfile }>> {
    return this.get(`/api/drivers-service/drivers/${userId}`, accessToken);
  }

  async environmentSettings(accessToken: string): Promise<HostApiResult> {
    return this.get('/api/environment-setting', accessToken);
  }

  async clientCredentialsToken(client: ServiceClient): Promise<string> {
    const response = await this.request.post(`${env.identityUrl}/connect/token`, {
      form: { grant_type: 'client_credentials', client_id: client.clientId, client_secret: client.secret, scope: HOST_API_SCOPE },
    });
    const body = await response.json();
    if (response.status() !== 200 || !body.access_token) {
      throw new Error(`${client.clientId} could not get a ${HOST_API_SCOPE} token: ${response.status()} ${body.error ?? ''}`);
    }
    return body.access_token;
  }

  private async get(path: string, accessToken?: string): Promise<HostApiResult> {
    if (!env.appApiUrl) {
      throw new Error('APP_API_URL is not set.');
    }
    const response = await this.request.get(`${env.appApiUrl}${path}`, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {}
    return { status: response.status(), body };
  }
}
