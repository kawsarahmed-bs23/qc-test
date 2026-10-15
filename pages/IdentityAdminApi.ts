import type { APIRequestContext } from '@playwright/test';
import { env } from '../config/environment';
import type { TokenResult } from './PasswordGrantApi';

export const ADMIN_API_SCOPE = 'quarryconnect.identity.admin';
export const ADMIN_API_ROOT = '/api/admin';

export interface AdminApiResult<T = any> {
  status: number;
  body: T;
  text: string;
}

export class IdentityAdminApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string | null,
  ) {}

  static async signIn(request: APIRequestContext): Promise<IdentityAdminApi> {
    const result = await serviceToken(request);
    if (result.status !== 200 || !result.body.access_token) {
      throw new Error(`The administration service client could not get a token: ${result.status} ${JSON.stringify(result.body)}`);
    }
    return new IdentityAdminApi(request, result.body.access_token);
  }

  get<T = any>(path: string): Promise<AdminApiResult<T>> {
    return this.send<T>('GET', path);
  }

  post<T = any>(path: string, body?: unknown): Promise<AdminApiResult<T>> {
    return this.send<T>('POST', path, body);
  }

  put<T = any>(path: string, body: unknown): Promise<AdminApiResult<T>> {
    return this.send<T>('PUT', path, body);
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<AdminApiResult<T>> {
    const response = await this.request.fetch(`${env.identityUrl}${ADMIN_API_ROOT}${path}`, {
      method,
      headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {},
      data: body,
    });
    const text = await response.text();
    return { status: response.status(), body: (text ? safeJson(text) : null) as T, text };
  }
}

export async function serviceToken(request: APIRequestContext, scope = ADMIN_API_SCOPE): Promise<TokenResult> {
  if (!env.adminApiClient) {
    throw new Error('ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET are not set.');
  }
  const response = await request.post(`${env.identityUrl}/connect/token`, {
    form: {
      grant_type: 'client_credentials',
      client_id: env.adminApiClient.clientId,
      client_secret: env.adminApiClient.secret,
      scope,
    },
  });
  return { status: response.status(), body: await response.json() };
}

export async function authorizeRedirect(request: APIRequestContext, query: Record<string, string>): Promise<string> {
  const response = await request.get(`${env.identityUrl}/connect/authorize?${new URLSearchParams(query)}`, { maxRedirects: 0 });
  return response.headers()['location'] ?? '';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
