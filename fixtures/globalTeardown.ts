import * as fs from 'fs';
import { canUseMasterDb, removeChangeLogsSince, type ChangeLogMark } from './localDb';
import { CHANGE_LOG_MARK } from './globalSetup';
import { adminAccount, canSeedPlatformAdmin, removePlatformAdmin } from './throwawayUsers';

export default function globalTeardown(): void {
  const admin = adminAccount();
  if (canUseMasterDb() && fs.existsSync(CHANGE_LOG_MARK)) {
    const mark = JSON.parse(fs.readFileSync(CHANGE_LOG_MARK, 'utf8')) as ChangeLogMark;
    if (admin) removeChangeLogsSince(mark, admin.email);
    fs.rmSync(CHANGE_LOG_MARK);
  }
  if (canSeedPlatformAdmin()) removePlatformAdmin();
}
