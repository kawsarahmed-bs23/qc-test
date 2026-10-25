import * as fs from 'fs';
import * as path from 'path';
import { env, type Credentials } from '../config/environment';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, runIdentitySeedScript, runMasterSeedScript } from './localDb';
import { newAuthenticatorKey } from './totp';

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
  const userId = queryIdentityDb(`SELECT Id FROM Users WHERE NormalizedEmail = UPPER(N'${email.replace(/'/g, "''")}')`);
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
