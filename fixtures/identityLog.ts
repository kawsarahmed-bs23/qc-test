import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config/environment';

export interface LogMark {
  file: string;
  offset: number;
}

export function canReadIdentityLog(): boolean {
  return env.identityLogDir !== null && fs.existsSync(env.identityLogDir);
}

export function markIdentityLog(): LogMark {
  const file = newestLogFile();
  return { file, offset: file ? fs.statSync(file).size : 0 };
}

export function identityLogSince(mark: LogMark): string {
  const file = newestLogFile();
  if (!file) {
    return '';
  }
  const start = file === mark.file ? mark.offset : 0;
  const buffer = fs.readFileSync(file);
  return buffer.subarray(start).toString('utf8');
}

export function resetLinkSince(mark: LogMark, email: string): string | null {
  const lines = identityLogSince(mark)
    .split(/\r?\n/)
    .filter((line) => line.includes(email) && line.includes('was not sent'));
  const match = lines.at(-1)?.match(/Link: "?([^"\s]+\/Account\/ResetPassword[^"\s]*)/);
  return match ? match[1] : null;
}

export function resetCodeSince(mark: LogMark, email: string): string | null {
  const sentTo = new RegExp(`for "?${escapeRegExp(email)}"? was not sent`, 'i');
  const lines = identityLogSince(mark)
    .split(/\r?\n/)
    .filter((line) => sentTo.test(line));
  const match = lines.at(-1)?.match(/Code: "?(\d{6})"?/);
  return match ? match[1] : null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function newestLogFile(): string {
  if (!env.identityLogDir) {
    throw new Error('IDENTITY_LOG_DIR is not set, or TEST_ENV is not local.');
  }
  const files = fs
    .readdirSync(env.identityLogDir)
    .filter((name) => /^identity-.*\.log$/.test(name))
    .map((name) => path.join(env.identityLogDir!, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? '';
}
