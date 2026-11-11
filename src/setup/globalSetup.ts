import * as fs from 'fs';
import * as path from 'path';
import { AUTH_DIR, env } from '@config/env.config';
import { canUseMasterDb, markChangeLogs } from '@utils/localDb';
import { canSeedPlatformAdmin, seedPlatformAdmin } from '@utils/throwawayUsers';

export const CHANGE_LOG_MARK = path.join(AUTH_DIR, env.name, 'change-log-mark.json');

export default function globalSetup(): void {
  if (canSeedPlatformAdmin()) seedPlatformAdmin();
  if (!canUseMasterDb()) return;
  fs.mkdirSync(path.dirname(CHANGE_LOG_MARK), { recursive: true });
  fs.writeFileSync(CHANGE_LOG_MARK, JSON.stringify(markChangeLogs()));
}
