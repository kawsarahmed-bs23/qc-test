import type { APIRequestContext } from '@playwright/test';
import { AdminApi, type AdminApiResult } from '@api/admin.api';
import type { HostEnvironmentJson, NewHostInput, ReadinessJson } from '@pages/setting-template.page';

export interface HostWithUuidInput extends NewHostInput {
  hostUuid?: string | null;
}

export interface HostCreateJson {
  hostUuid?: string;
  isReady?: boolean;
  errors?: Record<string, string | string[]>;
}

/** Admin API calls the QC-912 cases make: create a host with an optional existing UUID, and read its environment and readiness. */
export class HostExistingUuidApi {
  constructor(private readonly request: APIRequestContext) {}

  private get api(): AdminApi {
    return AdminApi.asAdmin(this.request);
  }

  createHost(input: HostWithUuidInput): Promise<AdminApiResult<HostCreateJson>> {
    return this.api.post<HostCreateJson>('/hosts', input);
  }

  environment(hostUuid: string): Promise<AdminApiResult<HostEnvironmentJson>> {
    return this.api.get<HostEnvironmentJson>(`/hosts/${hostUuid}/environment`);
  }

  readiness(hostUuid: string): Promise<AdminApiResult<ReadinessJson>> {
    return this.api.get<ReadinessJson>(`/hosts/${hostUuid}/readiness`);
  }

  /** The message of one field error in a 400 body, whatever case the API gives the key. */
  static fieldError(body: HostCreateJson | null, field: string): string | null {
    const entry = Object.entries(body?.errors ?? {}).find(([key]) => key.toLowerCase() === field.toLowerCase());
    if (!entry) return null;
    return Array.isArray(entry[1]) ? entry[1].join(' ') : entry[1];
  }
}
