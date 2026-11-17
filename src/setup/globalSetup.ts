import * as fs from 'fs';
import * as path from 'path';
import { AUTH_DIR, env } from '@config/env.config';
import { canUseMasterDb, markChangeLogs } from '@utils/localDb';
import { canSeedPlatformAdmin, seedPlatformAdmin } from '@utils/throwawayUsers';

export const CHANGE_LOG_MARK = path.join(AUTH_DIR, env.name, 'change-log-mark.json');

// The Admin API caches its list of platform admins for one minute, so a throwaway admin seeded into HOST_MASTER is
// refused ("Permission denied") while a cache loaded by the previous run is still alive. The mark records the last
// moment that run could have asked the API; the next run waits until a minute after it.
export const ADMIN_CACHE_MARK = path.join(AUTH_DIR, env.name, 'admin-cache-mark.txt');
const ADMIN_CACHE_SECONDS = 61;

export function touchAdminCacheMark(): void {
  fs.mkdirSync(path.dirname(ADMIN_CACHE_MARK), { recursive: true });
  fs.writeFileSync(ADMIN_CACHE_MARK, String(Date.now()));
}

async function waitForAdminCache(): Promise<void> {
  if (!fs.existsSync(ADMIN_CACHE_MARK)) return;
  const last = Number(fs.readFileSync(ADMIN_CACHE_MARK, 'utf8'));
  const waitMs = Number.isFinite(last) ? last + ADMIN_CACHE_SECONDS * 1000 - Date.now() : 0;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

export default async function globalSetup(): Promise<void> {
  if (canSeedPlatformAdmin()) {
    seedPlatformAdmin();
    await waitForAdminCache();
    touchAdminCacheMark();
  }
  if (!canUseMasterDb()) return;
  fs.mkdirSync(path.dirname(CHANGE_LOG_MARK), { recursive: true });
  fs.writeFileSync(CHANGE_LOG_MARK, JSON.stringify(markChangeLogs()));
}
