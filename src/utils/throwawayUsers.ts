import * as fs from 'fs';
import * as path from 'path';
import { env, type Credentials } from '@config/env.config';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, runIdentitySeedScript, runMasterSeedScript } from '@utils/localDb';
import { newAuthenticatorKey } from '@utils/totp';

export const PLATFORM_ADMIN_EMAIL = 'e2e.qc775.admin@quarryconnect.test';
export const PLATFORM_ADMIN_NAME = 'E2E QC-775 Admin';
const PLATFORM_ADMIN_FILE = path.join('.auth', env.name, 'platform-admin.json');

export interface ThrowawayUser extends Credentials {
  userId: string;
  authenticatorKey: string | null;
}

export function canSeedThrowawayUsers(): boolean {
  return env.admin !== null && canUseIdentityDb();
}

export function seedIdentityUser(email: string, lastName: string, twoFactor: boolean): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const authenticatorKey = twoFactor ? newAuthenticatorKey() : null;
  runIdentitySeedScript('identity-qc775-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: lastName,
    TwoFactor: twoFactor ? '1' : '0',
    AuthenticatorKey: authenticatorKey ?? 'none',
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function removeIdentityUsers(emailLike: string): void {
  runIdentitySeedScript('identity-qc775-users.remove.sql', { EmailLike: emailLike });
}

export function makePlatformAdmin(user: ThrowawayUser, displayName: string): void {
  runMasterSeedScript('master-qc775-platform-admin.apply.sql', { UserUuid: user.userId, DisplayName: displayName });
}

export function removePlatformAdmins(displayNameLike: string): void {
  runMasterSeedScript('master-qc775-platform-admin.remove.sql', { DisplayNameLike: displayNameLike });
}

export function canSeedPlatformAdmin(): boolean {
  return canSeedThrowawayUsers() && canUseMasterDb();
}

export function seedPlatformAdmin(): void {
  const admin = seedIdentityUser(PLATFORM_ADMIN_EMAIL, 'QC-775 Admin', true);
  makePlatformAdmin(admin, PLATFORM_ADMIN_NAME);
  fs.mkdirSync(path.dirname(PLATFORM_ADMIN_FILE), { recursive: true });
  fs.writeFileSync(PLATFORM_ADMIN_FILE, JSON.stringify({ email: admin.email, userId: admin.userId, authenticatorKey: admin.authenticatorKey }));
}

export function removePlatformAdmin(): void {
  removePlatformAdmins(PLATFORM_ADMIN_NAME);
  removeIdentityUsers(PLATFORM_ADMIN_EMAIL);
  fs.rmSync(PLATFORM_ADMIN_FILE, { force: true });
}

function seededPlatformAdmin(): { email: string; userId: string; authenticatorKey: string } | null {
  return fs.existsSync(PLATFORM_ADMIN_FILE) ? JSON.parse(fs.readFileSync(PLATFORM_ADMIN_FILE, 'utf8')) : null;
}

export function adminAccount(): Credentials | null {
  const seeded = seededPlatformAdmin();
  if (seeded && env.admin) {
    return { email: seeded.email, password: env.admin.password };
  }
  return env.admin;
}

export function adminAuthenticatorKey(): string | null {
  return seededPlatformAdmin()?.authenticatorKey ?? null;
}

export const QC823_PREFIX = 'e2e.qc823.';

export function seedQc823User(email: string, lastName: string, active = true): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  runIdentitySeedScript('identity-qc823-user.apply.sql', { Email: email, SourceEmail: env.admin.email, LastName: lastName, IsActive: active ? '1' : '0' });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  return { email, password: env.admin.password, userId, authenticatorKey: null };
}

export function removeQc823Users(): void {
  runIdentitySeedScript('identity-qc823.remove.sql');
}

export function makeQc823PlatformAdmin(user: ThrowawayUser, displayName: string): void {
  runMasterSeedScript('master-qc823-platform-admin.apply.sql', { UserUuid: user.userId, DisplayName: displayName });
}

export function removeQc823PlatformAdmins(): void {
  runMasterSeedScript('master-qc823-platform-admin.remove.sql');
}

export const QC876_PREFIX = 'e2e.qc876.';

export interface LockoutState {
  accessFailedCount: number;
  lockedOut: boolean;
}

export function seedQc876User(email: string, lastName: string, options: { active?: boolean; twoFactor?: boolean } = {}): ThrowawayUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  const authenticatorKey = options.twoFactor ? newAuthenticatorKey() : null;
  runIdentitySeedScript('identity-qc876-user.apply.sql', {
    Email: email,
    SourceEmail: env.admin.email,
    LastName: lastName,
    IsActive: options.active === false ? '0' : '1',
    TwoFactor: options.twoFactor ? '1' : '0',
    AuthenticatorKey: authenticatorKey ?? 'none',
  });
  const userId = queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
  if (!userId) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  return { email, password: env.admin.password, userId, authenticatorKey };
}

export function qc876LockoutState(user: ThrowawayUser): LockoutState {
  const row = queryIdentityDb(
    `SELECT CONCAT(AccessFailedCount, '|', CASE WHEN LockoutEnd > SYSDATETIMEOFFSET() THEN 1 ELSE 0 END) FROM auth.Users WHERE Id = N'${user.userId}' AND NormalizedEmail LIKE N'E2E.QC876.%'`,
  );
  if (!row) {
    throw new Error(`The throwaway user ${user.email} is missing.`);
  }
  const [count, locked] = row.split('|');
  return { accessFailedCount: Number(count), lockedOut: locked === '1' };
}

export function clearQc876Lockout(user: ThrowawayUser): void {
  queryIdentityDb(`UPDATE auth.Users SET LockoutEnd = NULL, AccessFailedCount = 0 WHERE Id = N'${user.userId}' AND NormalizedEmail LIKE N'E2E.QC876.%'`);
}

export function removeQc876Users(): void {
  runIdentitySeedScript('identity-qc876.remove.sql');
}

export function countQc876Users(): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC876.%'`));
}

export const QC897_PREFIX = 'e2e.qc897.';

export interface UuidUser extends ThrowawayUser {
  userUuid: string;
}

export function seedQc897User(email: string, lastName: string): UuidUser {
  if (!env.admin) {
    throw new Error('ADMIN_EMAIL / ADMIN_PASSWORD are not set; the throwaway users copy that password.');
  }
  runIdentitySeedScript('identity-qc897-user.apply.sql', { Email: email, SourceEmail: env.admin.email, LastName: lastName });
  const row = queryIdentityDb(
    `SELECT CONCAT(Id, '|', LOWER(CONVERT(nvarchar(36), UserUUID))) FROM auth.Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`,
  );
  if (!row) {
    throw new Error(`The throwaway user ${email} was not created.`);
  }
  const [userId, userUuid] = row.split('|');
  return { email, password: env.admin.password, userId, userUuid, authenticatorKey: null };
}

export function removeQc897Users(): void {
  runIdentitySeedScript('identity-qc897.remove.sql');
}

export function countQc897Leftovers(): number {
  return Number(
    queryIdentityDb(
      `SELECT (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC897.%')` +
        ` + (SELECT COUNT(*) FROM auth.PersistedGrants g WHERE NOT EXISTS (SELECT 1 FROM auth.Users u WHERE CONVERT(nvarchar(36), u.UserUUID) = g.SubjectId) AND g.SubjectId IS NOT NULL)` +
        ` + (SELECT COUNT(*) FROM app.UserSessions s WHERE NOT EXISTS (SELECT 1 FROM auth.Users u WHERE CONVERT(nvarchar(36), u.UserUUID) = s.SubjectID) AND s.SubjectID IS NOT NULL)`,
    ),
  );
}
