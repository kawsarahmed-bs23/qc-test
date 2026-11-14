import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '@config/env.config';
import { serviceToken } from '@api/identity-admin.api';
import { querySingleValue } from '@utils/localDb';

export const REPLY_CONFIRMATION_KEY = 'Dispatch:ReplyConfirmation';
export type ReplyConfirmationSetting = 'On' | 'Off';

/**
 * The host's Dispatch:ReplyConfirmation (QC-937). It is changed through the host API's PUT api/environment-setting with the Admin
 * service client's token, which reloads the host configuration; a direct change to app.EnvironmentSetting is not read until a restart.
 */
export class HostReplyConfirmation {
  constructor(private readonly request: APIRequestContext) {}

  current(): ReplyConfirmationSetting | null {
    const value = querySingleValue(
      `SELECT PropertyValue FROM app.EnvironmentSetting WHERE GroupName = 'Dispatch' AND SubGroupName IS NULL AND PropertyName = 'ReplyConfirmation'`,
    );
    return value === 'On' || value === 'Off' ? value : null;
  }

  async set(value: ReplyConfirmationSetting): Promise<void> {
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
    const setting = groups.flatMap((group) => group.settings).find((s) => s.configurationKey === REPLY_CONFIRMATION_KEY);
    if (!setting) throw new Error(`The host has no ${REPLY_CONFIRMATION_KEY} setting; apply host/up/202611131401.`);
    const saved = await this.request.put(`${env.appApiUrl}/api/environment-setting`, {
      headers,
      data: { settings: [{ environmentSettingId: setting.environmentSettingId, value }] },
    });
    if (saved.status() !== 200) throw new Error(`PUT api/environment-setting ${REPLY_CONFIRMATION_KEY}=${value} answered ${saved.status()}: ${await saved.text()}`);
  }
}

/** The Driver App's answer to an offer: a message reply with a response code (POST /driver-message/send). */
export class DriverAppReplyApi {
  constructor(
    private readonly request: APIRequestContext,
    private readonly accessToken: string,
  ) {}

  reply(orderAssignmentUuid: string, replyToMessageUuid: string, responseCode: string, messageBody: string): Promise<APIResponse> {
    if (!env.driversApiUrl) throw new Error('DRIVERS_API_URL is not set.');
    return this.request.post(`${env.driversApiUrl}/driver-message/send`, {
      headers: { Authorization: `Bearer ${this.accessToken}`, 'Idempotency-Key': crypto.randomUUID() },
      data: { orderAssignmentUuid, messageBody, replyToMessageUuid, responseCode },
    });
  }
}
