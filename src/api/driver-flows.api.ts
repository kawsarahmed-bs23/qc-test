import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';
import {
  queryDriversDb,
  queryIdentityDb,
  querySingleValue,
  runDriversSeedScript,
  runIdentitySeedScript,
  runSeedScript,
} from '@utils/localDb';
import type { HostAnswer } from '@api/host-assignments.api';

export const DFLOW_DOMAIN = 'example.com';
export const DFLOW_NOTES = 'e2e-dflow';

export function dflowEmail(name: string): string {
  return `e2e.dflow.${name}@${DFLOW_DOMAIN}`;
}

function requireDflow(email: string): string {
  if (!/^e2e\.dflow\.[a-z0-9.-]+@example\.com$/.test(email)) throw new Error(`${email} is not a DFLOW throwaway address.`);
  return email.replace(/'/g, "''");
}

export interface DflowWorld {
  orderId: number;
  vendorId: number;
  truckId: number;
}

export interface DflowRemoval {
  host: string;
  identity: string;
  drivers: string | null;
}

export function hostNumber(query: string): number {
  return Number(querySingleValue(query) ?? '0');
}

export function driversNumber(query: string): number {
  return Number(queryDriversDb(query) ?? '0');
}

export function queuesDrained(): boolean {
  return (
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_outgoing_envelopes`) === 0 &&
    hostNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0 &&
    driversNumber(`SELECT COUNT(*) FROM msg.wolverine_incoming_envelopes WHERE status = 'Incoming'`) === 0
  );
}

export async function waitForQueues(): Promise<void> {
  for (let wait = 0; wait < 40 && !queuesDrained(); wait++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export const DflowData = {
  hostUser(email: string): { id: string; userUuid: string | null; hasPassword: boolean; isActive: boolean; role: string | null; organisationId: number } | null {
    const row = querySingleValue(
      `SELECT CONCAT(u.Id, '|', ISNULL(LOWER(CONVERT(nvarchar(36), u.UserUUID)), 'NULL'), '|', CASE WHEN u.PasswordHash IS NULL THEN 0 ELSE 1 END, '|',` +
        ` CAST(u.IsActive AS int), '|', ISNULL((SELECT MIN(RoleName) FROM auth.UserToRoles r WHERE r.UserId = u.Id), 'NULL'), '|', u.OrganisationIdFk)` +
        ` FROM auth.Users u WHERE u.NormalizedEmail = UPPER(N'${requireDflow(email)}')`,
    );
    if (!row) return null;
    const [id, userUuid, hasPassword, isActive, role, organisationId] = row.split('|');
    return {
      id,
      userUuid: userUuid === 'NULL' ? null : userUuid,
      hasPassword: hasPassword === '1',
      isActive: isActive === '1',
      role: role === 'NULL' ? null : role,
      organisationId: Number(organisationId),
    };
  },

  identityUserCount(email: string): number {
    return Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireDflow(email)}')`) ?? '0');
  },

  identityUserUuid(email: string): string | null {
    return queryIdentityDb(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireDflow(email)}')`);
  },

  invites(userId: string): { uuid: string; status: number; type: string; accepted: string | null }[] {
    const rows = querySingleValue(
      `SELECT STRING_AGG(CONCAT(LOWER(CONVERT(nvarchar(36), UserInviteUUID)), '|', Status, '|', UserType, '|', ISNULL(LOWER(CONVERT(nvarchar(36), AcceptedUserUUID)), 'NULL')), '~')` +
        ` WITHIN GROUP (ORDER BY UserInviteID) FROM app.UserInvites WHERE UserID_FK = N'${userId.replace(/'/g, "''")}' AND Active = 1`,
    );
    if (!rows) return [];
    return rows.split('~').map((row) => {
      const [uuid, status, type, accepted] = row.split('|');
      return { uuid, status: Number(status), type, accepted: accepted === 'NULL' ? null : accepted };
    });
  },

  activeLinks(hostUuid: string, userUuid: string): number {
    return driversNumber(`SELECT COUNT(*) FROM app.DriverHostLinks WHERE HostUUID = '${hostUuid}' AND UserUUID = '${userUuid}' AND Active = 1`);
  },
};

export function seedDflowWorld(sourceOrderId: number, today: string): DflowWorld {
  const output = runSeedScript('host-dflow.apply.sql', { SourceOrder: String(sourceOrderId), Today: today });
  const ids = /IDS:(\d+),(\d+),(\d+)/.exec(output);
  if (!ids) throw new Error(`seed/host-dflow.apply.sql printed no ids: ${output}`);
  return { orderId: Number(ids[1]), vendorId: Number(ids[2]), truckId: Number(ids[3]) };
}

export function identityDflowSubs(): string[] {
  if (!env.identitySql) return [];
  const rows = queryIdentityDb(
    `SELECT STRING_AGG(LOWER(CONVERT(nvarchar(36), UserUUID)), ',') FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.DFLOW.%@EXAMPLE.COM' AND UserUUID IS NOT NULL`,
  );
  return rows ? rows.split(',') : [];
}

export function driversIsMigrated(): boolean {
  return !!env.driversSql && queryDriversDb(`SELECT CASE WHEN COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL OR OBJECT_ID(N'app.TripGps', N'U') IS NULL THEN 0 ELSE 1 END`) === '1';
}

export function removeDflowData(batchMark: string): DflowRemoval {
  const subs = identityDflowSubs();
  const drivers = driversIsMigrated() ? runDriversSeedScript('drivers-dflow.remove.sql', { UserIds: subs.length ? subs.join(',') : 'none' }) : null;
  const host = runSeedScript('host-dflow.remove.sql', { BatchMark: batchMark });
  const identity = runIdentitySeedScript('identity-dflow.remove.sql');
  return { host, identity, drivers };
}

export class DflowHostAdminApi {
  private token = '';

  constructor(private readonly request: APIRequestContext) {}

  async signIn(email: string, password: string): Promise<number> {
    const response = await this.request.post(`${hostApiUrl()}/api/account/login`, { data: { email, password }, ignoreHTTPSErrors: env.ignoreHttpsErrors });
    if (response.status() === 200) this.token = (await response.json()).data.accessToken as string;
    return response.status();
  }

  async createDriver(user: { email: string; firstName: string; lastName: string; truckId: number }): Promise<HostAnswer<string>> {
    const response = await this.request.post(`${hostApiUrl()}/api/manageusers/user-create`, {
      headers: { Authorization: `Bearer ${this.token}` },
      data: {
        userName: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        phoneNumber: '',
        role: 'Driver',
        isActive: true,
        organisationId: user.truckId,
        organisationLocationId: 0,
        canSetOrganisation: false,
        isBillingContact: false,
      },
      ignoreHTTPSErrors: env.ignoreHttpsErrors,
    });
    const text = await response.text();
    let data: string | null = null;
    try {
      data = text ? ((JSON.parse(text) as { data?: string }).data ?? null) : null;
    } catch {
      data = null;
    }
    return { status: response.status(), data, text };
  }

  bearer(): string {
    return this.token;
  }
}

function hostApiUrl(): string {
  if (!env.appApiUrl) throw new Error('APP_API_URL is not set.');
  return env.appApiUrl;
}
