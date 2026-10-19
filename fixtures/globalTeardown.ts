import * as fs from 'fs';
import { canUseMasterDb, removeChangeLogsSince, type ChangeLogMark } from './localDb';
import { CHANGE_LOG_MARK } from './globalSetup';

export default function globalTeardown(): void {
  if (!canUseMasterDb() || !fs.existsSync(CHANGE_LOG_MARK)) return;
  const mark = JSON.parse(fs.readFileSync(CHANGE_LOG_MARK, 'utf8')) as ChangeLogMark;
  removeChangeLogsSince(mark);
  fs.rmSync(CHANGE_LOG_MARK);
}
