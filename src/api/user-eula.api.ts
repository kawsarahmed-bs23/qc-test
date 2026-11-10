import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { env } from '@config/env.config';

export type UserEditArea = 'manageusers' | 'vendor';

export interface EulaStatusBody {
  status: 'accepted' | 'not-accepted' | 'rejected';
  statusDate: string | null;
  canReset: boolean;
}

/** The host API's user-edit EULA endpoints (QC-888), called with the bearer token of a signed-in app page. */
export class UserEulaApi {
  private accessToken = '';

  constructor(private readonly request: APIRequestContext) {}

  async useTokenOf(page: Page): Promise<void> {
    const token = await page.evaluate(() => localStorage.getItem('accessToken'));
    if (!token) {
      throw new Error('The app page has no access token; sign in first.');
    }
    this.accessToken = token;
  }

  userEdit(area: UserEditArea, userId: string): Promise<APIResponse> {
    return this.request.get(`${apiUrl()}/api/${area}/user-edit/${encodeURIComponent(userId)}`, { headers: this.headers() });
  }

  resetEula(area: UserEditArea, userId: string): Promise<APIResponse> {
    return this.request.post(`${apiUrl()}/api/${area}/user-edit/${encodeURIComponent(userId)}/reset-eula`, { headers: this.headers(), data: {} });
  }

  async eulaStatus(area: UserEditArea, userId: string): Promise<EulaStatusBody> {
    const response = await this.userEdit(area, userId);
    if (!response.ok()) {
      throw new Error(`GET ${area}/user-edit/${userId} answered ${response.status()}.`);
    }
    return (await response.json()).data.eulaStatus as EulaStatusBody;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}` };
  }
}

function apiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
