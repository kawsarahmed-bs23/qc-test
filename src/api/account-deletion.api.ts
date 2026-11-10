import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import type { DriverSettings, DriversEnvelope, DriversResult } from '@api/driver-settings.api';

export const RESTORE_DAYS = 30;
export const PENDING_DELETION_MESSAGE = 'Your account is scheduled for deletion. Restore it to keep using the app.';
export const UTC_WHOLE_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

export interface AccountDeletion {
  Status: 'none' | 'pending';
  DeletionRequestedAt: string | null;
  DeletionScheduledFor: string | null;
  DeletionCanceledAt: string | null;
  RestoreDays: number;
}

/** The Driver's own account deletion (QC-902 part 2, `GET/POST/DELETE /me/deletion`) and the routes it locks while pending. */
export class AccountDeletionApi {
  constructor(private readonly request: APIRequestContext) {}

  status(accessToken: string | null): Promise<DriversResult<AccountDeletion>> {
    return this.read(this.request.get(`${baseUrl()}/me/deletion`, { headers: headers(accessToken) }));
  }

  requestDeletion(accessToken: string | null): Promise<DriversResult<AccountDeletion>> {
    return this.read(this.request.post(`${baseUrl()}/me/deletion`, { headers: headers(accessToken) }));
  }

  restore(accessToken: string | null): Promise<DriversResult<AccountDeletion>> {
    return this.read(this.request.delete(`${baseUrl()}/me/deletion`, { headers: headers(accessToken) }));
  }

  hosts(accessToken: string): Promise<DriversResult<unknown>> {
    return this.read(this.request.get(`${baseUrl()}/me/hosts`, { headers: headers(accessToken) }));
  }

  settings(accessToken: string): Promise<DriversResult<DriverSettings | AccountDeletion>> {
    return this.read(this.request.get(`${baseUrl()}/me/settings`, { headers: headers(accessToken) }));
  }

  saveSettings(accessToken: string, body: Partial<DriverSettings>): Promise<DriversResult<DriverSettings | AccountDeletion>> {
    return this.read(this.request.put(`${baseUrl()}/me/settings`, { headers: headers(accessToken), data: body }));
  }

  invites(accessToken: string): Promise<DriversResult<unknown>> {
    return this.read(this.request.get(`${baseUrl()}/invites`, { headers: headers(accessToken) }));
  }

  private async read<T>(pending: Promise<APIResponse>): Promise<DriversResult<T>> {
    const response = await pending;
    const text = await response.text();
    let body: DriversEnvelope<T> = {};
    try {
      body = text ? (JSON.parse(text) as DriversEnvelope<T>) : {};
    } catch {
      body = { message: text };
    }
    return { status: response.status(), body };
  }
}

function headers(accessToken: string | null): Record<string, string> {
  return accessToken === null ? {} : { Authorization: `Bearer ${accessToken}` };
}

function baseUrl(): string {
  if (!env.driversApiUrl) {
    throw new Error('DRIVERS_API_URL is not set.');
  }
  return env.driversApiUrl;
}
