import { execFileSync } from 'child_process';
import * as path from 'path';
import { env, type LocalSql } from '../config/environment';

const SEED_DIR = path.resolve(__dirname, '..', 'seed');

export function canSeedLocalDb(): boolean {
  return env.localSql !== null;
}

export function runSeedScript(fileName: string): string {
  if (!env.localSql) {
    throw new Error('LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE are not set, or TEST_ENV is not local.');
  }

  return execFileSync(
    'sqlcmd',
    ['-S', env.localSql.server, '-d', env.localSql.database, '-E', '-C', '-I', '-b', '-i', path.join(SEED_DIR, fileName)],
    { encoding: 'utf8' },
  );
}

export function querySingleValue(query: string): string | null {
  if (!env.localSql) {
    throw new Error('LOCAL_SQL_SERVER / LOCAL_SQL_DATABASE are not set, or TEST_ENV is not local.');
  }

  return runQuery(env.localSql, query);
}

export function canUseIdentityDb(): boolean {
  return env.identitySql !== null;
}

export function queryIdentityDb(query: string): string | null {
  if (!env.identitySql) {
    throw new Error('LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE are not set, or TEST_ENV is not local.');
  }

  return runQuery(env.identitySql, query);
}

function runQuery(sql: LocalSql, query: string): string | null {
  const output = execFileSync(
    'sqlcmd',
    ['-S', sql.server, '-d', sql.database, '-E', '-C', '-I', '-b', '-h', '-1', '-W', '-Q', `SET NOCOUNT ON; ${query}`],
    { encoding: 'utf8' },
  ).trim();

  return output === '' || output === 'NULL' ? null : output;
}

export interface IdentityPasswordSnapshot {
  passwordHash: string | null;
  securityStamp: string | null;
  passwordResetFlag: number;
}

export function snapshotIdentityPassword(where: string): IdentityPasswordSnapshot {
  return {
    passwordHash: queryIdentityDb(`SELECT PasswordHash FROM Users WHERE ${where}`),
    securityStamp: queryIdentityDb(`SELECT SecurityStamp FROM Users WHERE ${where}`),
    passwordResetFlag: Number(queryIdentityDb(`SELECT CAST(PasswordResetFlag AS int) FROM Users WHERE ${where}`)),
  };
}

export function restoreIdentityPassword(where: string, snapshot: IdentityPasswordSnapshot): void {
  queryIdentityDb(
    `UPDATE Users SET PasswordHash = ${sqlText(snapshot.passwordHash)}, SecurityStamp = ${sqlText(snapshot.securityStamp)}, PasswordResetFlag = ${snapshot.passwordResetFlag} WHERE ${where}`,
  );
}

function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`;
}
