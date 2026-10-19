import * as fs from 'fs';
import type { APIRequestContext, Page } from '@playwright/test';
import { ADMIN_STATE, env } from '../config/environment';

export interface AdminApiResult<T = any> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, string>;
}

export function canUseAdminApi(): boolean {
  return env.adminApiUrl !== null;
}

export function findAccessToken(value: unknown): string | null {
  if (typeof value === 'string') {
    try {
      return findAccessToken(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.access_token === 'string') {
      return record.access_token;
    }
    for (const child of Object.values(record)) {
      const found = findAccessToken(child);
      if (found) return found;
    }
  }
  return null;
}

export function adminTokenFromState(file = ADMIN_STATE): string {
  const state = JSON.parse(fs.readFileSync(file, 'utf8')) as { origins: { origin: string; localStorage: { name: string; value: string }[] }[] };
  const origin = state.origins.find((o) => o.origin === env.adminUrl);
  const token = findAccessToken(Object.fromEntries((origin?.localStorage ?? []).map((item) => [item.name, item.value])));
  if (!token) {
    throw new Error(`No access token for ${env.adminUrl} in ${file}; the setup sign-in did not finish.`);
  }
  return token;
}

export async function accessTokenFromPage(page: Page): Promise<string | null> {
  const storage = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])));
  return findAccessToken(storage);
}

export class AdminApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string | null,
  ) {}

  static asAdmin(request: APIRequestContext): AdminApi {
    return new AdminApi(request, adminTokenFromState());
  }

  get<T = any>(path: string, headers: Record<string, string> = {}): Promise<AdminApiResult<T>> {
    return this.send<T>('GET', path, undefined, headers);
  }

  put<T = any>(path: string, body: unknown): Promise<AdminApiResult<T>> {
    return this.send<T>('PUT', path, body);
  }

  post<T = any>(path: string, body?: unknown): Promise<AdminApiResult<T>> {
    return this.send<T>('POST', path, body ?? {});
  }

  preflight(path: string, origin: string, method = 'GET'): Promise<AdminApiResult> {
    return this.send('OPTIONS', path, undefined, {
      Origin: origin,
      'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'authorization',
    });
  }

  private async send<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<AdminApiResult<T>> {
    if (!env.adminApiUrl) {
      throw new Error('ADMIN_API_URL is not set.');
    }
    const response = await this.request.fetch(`${env.adminApiUrl}/api${path}`, {
      method,
      headers: { ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}), ...headers },
      data: body,
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
      maxRedirects: 0,
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status(), body: parsed as T, text, headers: response.headers() };
  }
}
