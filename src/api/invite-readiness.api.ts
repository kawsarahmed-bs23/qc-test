import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';
import { serviceToken } from '@api/identity-admin.api';
import { AdminApi } from '@api/admin.api';
import { queryMasterDb, querySingleValue } from '@utils/localDb';

export const HOST_KEY_ALREADY_REGISTERED = "The host's invite key is already registered.";
export const HOST_KEY_NOT_SET_UP = 'Invites are not set up for this host yet.';

export type HostInviteKeyState = 'registered' | 'not-registered' | 'not-set-up' | 'unreachable';

export interface HostInviteKeyStatus {
  state: HostInviteKeyState;
  kid: string | null;
}

export interface ReadinessResult {
  status: number;
  text: string;
  key: { kid: string; kty: string; crv: string; x: string; y: string } | null;
}

export async function readinessKey(request: APIRequestContext, token: string | null): Promise<ReadinessResult> {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  const response = await request.get(`${env.appApiUrl}/api/invite-readiness/key`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ignoreHTTPSErrors: env.ignoreHttpsErrors,
  });
  const text = await response.text();
  let key: ReadinessResult['key'] = null;
  try {
    key = (JSON.parse(text) as { data?: ReadinessResult['key'] }).data ?? null;
  } catch {
    key = null;
  }
  return { status: response.status(), text, key };
}

export async function hostServiceToken(request: APIRequestContext): Promise<string> {
  const token = await serviceToken(request, 'quarryconnect.api');
  if (token.status !== 200 || !token.body.access_token) throw new Error(`The Admin service client could not get a quarryconnect.api token: ${token.status}`);
  return token.body.access_token;
}

export async function hostInviteKid(request: APIRequestContext): Promise<string | null> {
  const answer = await readinessKey(request, await hostServiceToken(request));
  return answer.status === 200 ? (answer.key?.kid ?? null) : null;
}

export async function hostKeyStatus(request: APIRequestContext, hostUuid: string): Promise<HostInviteKeyStatus> {
  const answer = await AdminApi.asAdmin(request).get<HostInviteKeyStatus>(`/hosts/${hostUuid}/invite-keys/host`);
  if (answer.status !== 200) throw new Error(`GET invite-keys/host answered ${answer.status}: ${answer.text}`);
  return answer.body;
}

export async function registerHostKey(request: APIRequestContext, hostUuid: string): Promise<{ status: number; text: string }> {
  const answer = await AdminApi.asAdmin(request).post(`/hosts/${hostUuid}/invite-keys/register`);
  return { status: answer.status, text: answer.text };
}

export function activeInviteKeyCount(hostUuid: string, kid: string): number {
  return Number(
    queryMasterDb(
      `SELECT COUNT(*) FROM app.HostInviteSigningKeys k JOIN app.Hosts h ON h.HostID = k.HostID_FK WHERE h.HostUUID = '${hostUuid}' AND k.Kid = N'${kid.replace(/'/g, "''")}' AND k.Active = 1`,
    ) ?? '0',
  );
}

export async function createOrganisationUser(request: APIRequestContext, token: string, email: string, organisationId: number): Promise<{ status: number; id: string | null; text: string }> {
  const response = await request.post(`${env.appApiUrl}/api/manageusers/user-create`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      userName: email,
      firstName: 'Hik',
      lastName: 'Register',
      phoneNumber: '',
      role: 'Sales',
      isActive: true,
      organisationId,
      organisationLocationId: 0,
      canSetOrganisation: false,
      isBillingContact: false,
    },
    ignoreHTTPSErrors: env.ignoreHttpsErrors,
  });
  const text = await response.text();
  let id: string | null = null;
  try {
    id = (JSON.parse(text) as { data?: string }).data ?? null;
  } catch {
    id = null;
  }
  return { status: response.status(), id, text };
}

export function hostOrganisationId(): number {
  return Number(querySingleValue(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'`) ?? '30');
}
