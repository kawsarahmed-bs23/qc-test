import * as crypto from 'crypto';

/**
 * QC-914: signs the Host invite links Identity's /invite pages read, and reads the result token Identity sends back
 * to the link's return_url. Node crypto only: ES256 (ieee-p1363) for the link, RS256 against Identity's JWKS for the result.
 */

export const INVITE_AUDIENCE = 'quarryconnect.identity.invite';
export const INVITE_TYPE = 'qc-invite+jwt';
export const INVITE_RESULT_TYPE = 'qc-invite-result+jwt';
export const INVITE_MAX_LIFETIME_SECONDS = 24 * 3600;

export type InviteUserType = 'host' | 'customer' | 'vendor' | 'driver';

export interface InviteLinkOptions {
  privateJwk: string;
  issuer: string;
  email: string;
  returnUrl: string;
  givenName?: string;
  familyName?: string;
  userType?: string;
  kid?: string;
  audience?: string;
  jti?: string;
  issuedAt?: number;
  expiresAt?: number;
  typ?: string;
}

export interface InviteLink {
  token: string;
  jti: string;
}

export interface InviteResultClaims {
  iss: string;
  aud: string;
  invite: string;
  result: 'accepted' | 'declined' | string;
  sub?: string;
  email: string;
  given_name?: string;
  family_name?: string;
  user_type: string;
  complete_url: string;
  iat: number;
  exp: number;
}

export interface InviteResult {
  token: string;
  header: { alg: string; typ: string; kid: string };
  payload: InviteResultClaims;
}

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

export function nowInSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function signInviteLink(options: InviteLinkOptions): InviteLink {
  const jwk = JSON.parse(options.privateJwk) as crypto.JsonWebKey & { kid?: string };
  const jti = options.jti ?? crypto.randomUUID();
  const iat = options.issuedAt ?? nowInSeconds();
  const exp = options.expiresAt ?? iat + INVITE_MAX_LIFETIME_SECONDS;
  const header = { alg: 'ES256', typ: options.typ ?? INVITE_TYPE, kid: options.kid ?? jwk.kid };
  const payload = {
    iss: options.issuer,
    aud: options.audience ?? INVITE_AUDIENCE,
    jti,
    iat,
    exp,
    email: options.email,
    given_name: options.givenName ?? 'Qc914',
    family_name: options.familyName ?? 'Tester',
    user_type: options.userType ?? 'driver',
    return_url: options.returnUrl,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(input), {
    key: crypto.createPrivateKey({ key: jwk, format: 'jwk' }),
    dsaEncoding: 'ieee-p1363',
  });
  return { token: `${input}.${base64url(signature)}`, jti };
}

/** Changes claims in a signed link and keeps the original signature, so the signature no longer matches. */
export function tamperInviteLink(token: string, changes: Record<string, unknown>): string {
  const [header, payload, signature] = token.split('.');
  const claims = { ...JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')), ...changes };
  return `${header}.${base64url(JSON.stringify(claims))}.${signature}`;
}

/** Reads `invite_result` from the URL Identity redirected to. */
export function inviteResultFrom(url: string): InviteResult {
  const token = new URL(url).searchParams.get('invite_result');
  if (!token) {
    throw new Error('The return URL carries no invite_result.');
  }
  const [header, payload] = token.split('.');
  return {
    token,
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
  };
}

/** True when the result token's signature matches the key with its kid in Identity's JWKS. */
export function inviteResultSignedBy(result: InviteResult, jwks: { keys: (crypto.JsonWebKey & { kid?: string })[] }): boolean {
  const jwk = jwks.keys.find((key) => key.kid === result.header.kid);
  if (!jwk) return false;
  const [header, payload, signature] = result.token.split('.');
  return crypto.verify('sha256', Buffer.from(`${header}.${payload}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'));
}

export function newInvitePassword(): string {
  return `Qc914!${crypto.randomBytes(6).toString('hex')}Aa1`;
}
