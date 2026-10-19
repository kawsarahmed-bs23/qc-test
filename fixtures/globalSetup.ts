import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/environment';
import { canUseMasterDb, markChangeLogs } from './localDb';

export const CHANGE_LOG_MARK = path.join('.auth', env.name, 'change-log-mark.json');

export default function globalSetup(): void {
  if (!canUseMasterDb()) return;
  fs.mkdirSync(path.dirname(CHANGE_LOG_MARK), { recursive: true });
  fs.writeFileSync(CHANGE_LOG_MARK, JSON.stringify(markChangeLogs()));
}
