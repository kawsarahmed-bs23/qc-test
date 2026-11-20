import * as crypto from 'crypto';
import type { APIRequestContext } from '@playwright/test';
import { env } from '@config/env.config';
import { queryIdentityDb, querySingleValue, runIdentitySeedScript, runSeedScript } from '@utils/localDb';
import { qc913Email } from '@api/user-invites.api';

/**
 * QC-1008: the Send Password Reset button and the Sign-in emails log of Edit User and the Vendor Portal user page. The host API
 * asks Identity (POST/GET api/host/users/{userUuid}/...) with a short-lived ES256 token signed with the host's invite key;
 * Identity keeps SendStatus, SendFailure and RequestedByHostUserId on auth.PasswordResetLinks and auth.MagicLinkTokens and the
 * refusals in auth.AccountEmailRefusals. Throwaway people reuse the QC-913 e2e.qc913.* addresses so removeQc913Data() removes them.
 */

export const QC1008_CLIENT = 'host.local';
export const QC1008_OTHER_CLIENT = 'host.qc660test';
export const EMAIL_OFF_RESET_SENT = (email: string) => `Email is turned off at Identity, so the password reset to ${email} was not sent.`;
export const RESET_TOO_SOON = 'A password reset was sent to this user less than a minute ago. Try again in a minute.';
export const NO_EMAILS_YET = 'No sign-in emails yet.';

export function usemEmail(name: string): string {
  return qc913Email(`usem-${name}`);
}

function sqlText(value: string): string {
  return value.replace(/'/g, "''");
}

function requireThrowaway(email: string): string {
  if (!/^e2e\.qc913\.[a-z0-9.-]+@example\.com$/.test(email)) throw new Error(`${email} is not a throwaway address.`);
  return sqlText(email);
}

export interface SendRow {
  clientId: string | null;
  sendStatus: number | null;
  sendFailure: string | null;
  requestedBy: string | null;
  created: Date;
}

export interface RefusalRow {
  clientId: string | null;
  kind: string;
  reason: string;
  requestedBy: string | null;
  created: Date;
}

function sendRows(table: 'PasswordResetLinks' | 'MagicLinkTokens', email: string): SendRow[] {
  const rows = queryIdentityDb(
    `SELECT STRING_AGG(CONCAT(ISNULL(l.ClientId, 'NULL'), '|', ISNULL(CAST(l.SendStatus AS varchar(3)), 'NULL'), '|', ISNULL(l.SendFailure, 'NULL'), '|',` +
      ` ISNULL(l.RequestedByHostUserId, 'NULL'), '|', CONVERT(varchar(33), SWITCHOFFSET(l.Created, '+00:00'), 127)), '~') WITHIN GROUP (ORDER BY l.Created)` +
      ` FROM auth.${table} l JOIN auth.Users u ON u.Id = l.UserId WHERE u.NormalizedEmail = UPPER(N'${requireThrowaway(email)}')`,
  );
  if (!rows) return [];
  const orNull = (v: string) => (v === 'NULL' ? null : v);
  return rows.split('~').map((line) => {
    const [clientId, status, failure, requestedBy, created] = line.split('|');
    return {
      clientId: orNull(clientId),
      sendStatus: status === 'NULL' ? null : Number(status),
      sendFailure: orNull(failure),
      requestedBy: orNull(requestedBy),
      created: new Date(created),
    };
  });
}

export const Qc1008Data = {
  resetLinks: (email: string): SendRow[] => sendRows('PasswordResetLinks', email),

  magicLinks: (email: string): SendRow[] => sendRows('MagicLinkTokens', email),

  refusals(email: string): RefusalRow[] {
    const rows = queryIdentityDb(
      `SELECT STRING_AGG(CONCAT(ISNULL(r.ClientId, 'NULL'), '|', r.Kind, '|', r.Reason, '|', ISNULL(r.RequestedByHostUserId, 'NULL'), '|',` +
        ` CONVERT(varchar(33), SWITCHOFFSET(r.Created, '+00:00'), 127)), '~') WITHIN GROUP (ORDER BY r.Created)` +
        ` FROM auth.AccountEmailRefusals r JOIN auth.Users u ON u.Id = r.UserId WHERE u.NormalizedEmail = UPPER(N'${requireThrowaway(email)}')`,
    );
    if (!rows) return [];
    return rows.split('~').map((line) => {
      const [clientId, kind, reason, requestedBy, created] = line.split('|');
      return {
        clientId: clientId === 'NULL' ? null : clientId,
        kind,
        reason,
        requestedBy: requestedBy === 'NULL' ? null : requestedBy,
        created: new Date(created),
      };
    });
  },

  identityUserId(email: string): string {
    const id = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${requireThrowaway(email)}')`);
    if (!id) throw new Error(`${email} has no Identity login.`);
    return id;
  },

  /** The display name the host log uses for a host user: first and last name. */
  hostUserName(userId: string): string {
    const name = querySingleValue(`SELECT LTRIM(RTRIM(CONCAT(FirstName, N' ', LastName))) FROM auth.Users WHERE Id = N'${sqlText(userId)}'`);
    if (!name) throw new Error(`Host user ${userId} has no name.`);
    return name;
  },

  /** Created (UTC) of the newest app.UserInvites row of a host user. */
  inviteCreated(userId: string): Date {
    const created = querySingleValue(
      `SELECT TOP 1 CONVERT(varchar(23), Created, 126) + 'Z' FROM app.UserInvites WHERE UserID_FK = N'${sqlText(userId)}' AND Active = 1 ORDER BY Created DESC`,
    );
    if (!created) throw new Error(`Host user ${userId} has no invite row.`);
    return new Date(created);
  },

  seedIdentityHistory(email: string, adminId: string): void {
    runIdentitySeedScript('identity-qc1008.apply.sql', { Email: email, AdminId: adminId, HostClient: QC1008_CLIENT, OtherClient: QC1008_OTHER_CLIENT });
  },

  /** Links the host user to the Identity login of the same address (UserUUID) and optionally adds a Sent invite row. */
  seedHostUser(email: string, link: boolean, invite?: { hoursAgo: number; sentBy: string }): void {
    const uuid = link ? Qc1008Data.identityUserId(email) : 'none';
    runSeedScript('host-qc1008.apply.sql', { Email: email, UserUuid: uuid, InviteHoursAgo: String(invite?.hoursAgo ?? 0), SentBy: invite?.sentBy ?? 'none' });
  },

  removeHost(): string {
    return runSeedScript('host-qc1008.remove.sql');
  },

  removeIdentity(): string {
    return runIdentitySeedScript('identity-qc1008.remove.sql');
  },

  /** The host organisation (EnvironmentSetting HostOrganisationId) a throwaway Sales user is put in. */
  hostOrganisationId(): number {
    const id = querySingleValue(`SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'`);
    if (!id) throw new Error('The host has no HostOrganisationId setting.');
    return Number(id);
  },

  /** Read only: the id of an existing host user (the shared host app admin, who acts in the cases and is never changed). */
  hostUserIdByEmail(email: string): string {
    const id = querySingleValue(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${sqlText(email)}')`);
    if (!id) throw new Error(`${email} is not a host user.`);
    return id;
  },
};

const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export interface ForgedToken {
  label: string;
  header: string | null;
}

/** Identity's Host-only API with hand-made bearer tokens; none of them can be valid, so every call must answer 401. */
export class IdentityHostApi {
  constructor(private readonly request: APIRequestContext) {}

  private url(userUuid: string, tail: 'password-reset' | 'email-log'): string {
    return `${env.identityUrl}/api/host/users/${userUuid}/${tail}`;
  }

  private claims(hostUuid: string, audience: string): Record<string, unknown> {
    const iat = Math.floor(Date.now() / 1000);
    return { iss: hostUuid, aud: audience, iat, exp: iat + 60, jti: crypto.randomUUID() };
  }

  /** An unsigned (alg none) token and tokens signed with a key Identity has never seen, for the given host and audience. */
  forgedTokens(hostUuid: string): ForgedToken[] {
    const signedWithThrowawayKey = (typ: string, audience: string, kid: string): string => {
      const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const input = `${b64(JSON.stringify({ alg: 'ES256', typ, kid }))}.${b64(JSON.stringify(this.claims(hostUuid, audience)))}`;
      const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      return `${input}.${b64(signature)}`;
    };
    const unsigned = `${b64(JSON.stringify({ alg: 'none', typ: 'qc-host+jwt' }))}.${b64(JSON.stringify(this.claims(hostUuid, 'quarryconnect.identity.host')))}.`;

    return [
      { label: 'no Authorization header', header: null },
      { label: 'a Basic scheme', header: 'Basic ZTJlOmUyZQ==' },
      { label: 'a garbage bearer', header: 'Bearer not-a-token' },
      { label: 'an unsigned (alg none) token for the host', header: `Bearer ${unsigned}` },
      { label: 'a token for the host signed with a throwaway key', header: `Bearer ${signedWithThrowawayKey('qc-host+jwt', 'quarryconnect.identity.host', 'throwaway')}` },
      { label: 'a throwaway-key token with the host key id', header: `Bearer ${signedWithThrowawayKey('qc-host+jwt', 'quarryconnect.identity.host', 'p1-local-1')}` },
      { label: 'a throwaway-key token for the wrong audience', header: `Bearer ${signedWithThrowawayKey('qc-host+jwt', 'quarryconnect.identity.invite', 'p1-local-1')}` },
      { label: 'a throwaway-key token of the wrong type', header: `Bearer ${signedWithThrowawayKey('JWT', 'quarryconnect.identity.host', 'p1-local-1')}` },
    ];
  }

  async resetStatus(userUuid: string, header: string | null): Promise<number> {
    const response = await this.request.post(this.url(userUuid, 'password-reset'), {
      headers: header ? { Authorization: header } : {},
      data: { requestedByHostUserId: 'e2e-qc1008' },
      maxRedirects: 0,
    });
    return response.status();
  }

  async logStatus(userUuid: string, header: string | null): Promise<number> {
    const response = await this.request.get(this.url(userUuid, 'email-log'), { headers: header ? { Authorization: header } : {}, maxRedirects: 0 });
    return response.status();
  }
}
