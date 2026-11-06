import { createHash } from 'crypto';
import { env } from '../config/environment';
import { queryMasterDb, querySingleValue } from './localDb';

export const UNREACHABLE_HOST_KEY = 'e2e-qc744-unreachable';
export const NO_API_HOST_KEY = 'e2e-qc744-no-api';

export interface SettingKey {
  group: string;
  property: string;
}

export interface SettingRowSnapshot {
  key: string;
  master: { value: string | null; updated: string; updatedBy: string | null } | null;
  host: { value: string | null; updatedOn: string | null; updatedBy: string | null } | null;
}

export interface EnvironmentSyncSnapshot {
  hostId: number;
  row: string | null;
}

export function sqlText(value: string | null): string {
  return value === null ? 'NULL' : `N'${value.replace(/'/g, "''")}'`;
}

export function settingKey(key: string): SettingKey {
  const at = key.lastIndexOf(':');
  return { group: key.slice(0, at), property: key.slice(at + 1) };
}

function masterWhere(hostId: number, key: string): string {
  const { group, property } = settingKey(key);
  return `HostID_FK = ${hostId} AND Active = 1 AND GroupName = ${sqlText(group)} AND SubGroupName IS NULL AND PropertyName = ${sqlText(property)}`;
}

function hostWhere(key: string): string {
  const { group, property } = settingKey(key);
  return `GroupName = ${sqlText(group)} AND SubGroupName IS NULL AND PropertyName = ${sqlText(property)}`;
}

export function hostIdByKey(hostKey: string): number {
  return Number(queryMasterDb(`SELECT HostID FROM app.Hosts WHERE HostKey = ${sqlText(hostKey)}`));
}

export function hostUuidByKey(hostKey: string): string {
  return queryMasterDb(`SELECT CAST(HostUUID AS varchar(36)) FROM app.Hosts WHERE HostKey = ${sqlText(hostKey)}`)!.toLowerCase();
}

export function masterValue(hostId: number, key: string): string | null {
  return queryMasterDb(`SELECT ISNULL(PropertyValue, N'<null>') FROM app.HostEnvironmentSettings WHERE ${masterWhere(hostId, key)}`)?.replace(/^<null>$/, '') ?? null;
}

export function masterStamp(hostId: number, key: string): string | null {
  return queryMasterDb(`SELECT CONVERT(varchar(30), Updated, 126) + '|' + ISNULL(UpdatedBy, '') FROM app.HostEnvironmentSettings WHERE ${masterWhere(hostId, key)}`);
}

export function masterUuid(hostId: number, key: string): string {
  return queryMasterDb(`SELECT CAST(HostEnvironmentSettingUUID AS varchar(36)) FROM app.HostEnvironmentSettings WHERE ${masterWhere(hostId, key)}`)!.toLowerCase();
}

export function hostValue(key: string): string | null {
  return querySingleValue(`SELECT ISNULL(PropertyValue, '<null>') FROM app.EnvironmentSetting WHERE ${hostWhere(key)}`)?.replace(/^<null>$/, '') ?? null;
}

export function hostStamp(key: string): string | null {
  return querySingleValue(`SELECT ISNULL(CONVERT(varchar(30), UpdatedOn, 126), '') + '|' + ISNULL(UpdatedBy, '') FROM app.EnvironmentSetting WHERE ${hostWhere(key)}`);
}

export function setHostValue(key: string, value: string): void {
  querySingleValue(`UPDATE app.EnvironmentSetting SET PropertyValue = ${sqlText(value)} WHERE ${hostWhere(key)}`);
}

export function snapshotSettingRows(hostId: number, keys: string[]): SettingRowSnapshot[] {
  return keys.map((key) => {
    const master = queryMasterDb(
      `SELECT ISNULL(PropertyValue, N'<null>') + '|' + CONVERT(varchar(30), Updated, 126) + '|' + ISNULL(UpdatedBy, N'<null>') FROM app.HostEnvironmentSettings WHERE ${masterWhere(hostId, key)}`,
    );
    const host = querySingleValue(
      `SELECT ISNULL(PropertyValue, '<null>') + '|' + ISNULL(CONVERT(varchar(30), UpdatedOn, 126), '<null>') + '|' + ISNULL(UpdatedBy, '<null>') FROM app.EnvironmentSetting WHERE ${hostWhere(key)}`,
    );
    const nullable = (part: string) => (part === '<null>' ? null : part);
    const [mValue, mUpdated, mBy] = (master ?? '').split('|');
    const [hValue, hUpdated, hBy] = (host ?? '').split('|');
    return {
      key,
      master: master === null ? null : { value: nullable(mValue), updated: mUpdated, updatedBy: nullable(mBy) },
      host: host === null ? null : { value: nullable(hValue), updatedOn: nullable(hUpdated), updatedBy: nullable(hBy) },
    };
  });
}

export function restoreSettingRows(hostId: number, snapshots: SettingRowSnapshot[]): void {
  for (const { key, master, host } of snapshots) {
    if (master) {
      queryMasterDb(
        `UPDATE app.HostEnvironmentSettings SET PropertyValue = ${sqlText(master.value)}, Updated = '${master.updated}', UpdatedBy = ${sqlText(master.updatedBy)} WHERE ${masterWhere(hostId, key)}`,
      );
    }
    if (host) {
      querySingleValue(
        `UPDATE app.EnvironmentSetting SET PropertyValue = ${sqlText(host.value)}, UpdatedOn = ${host.updatedOn === null ? 'NULL' : `'${host.updatedOn}'`}, UpdatedBy = ${sqlText(host.updatedBy)} WHERE ${hostWhere(key)}`,
      );
    }
  }
}

export function snapshotEnvironmentSync(hostId: number): EnvironmentSyncSnapshot {
  return {
    hostId,
    row: queryMasterDb(
      `SELECT CONVERT(varchar(30), LastSyncedAt, 126) + '|' + ISNULL(LastStatus, N'<null>') + '|' + ISNULL(LastError, N'<null>') + '|' + CONVERT(varchar(30), Updated, 126) + '|' + ISNULL(UpdatedBy, N'<null>') FROM app.HostSyncs WHERE HostID_FK = ${hostId} AND Area = N'Environment' AND Active = 1`,
    ),
  };
}

export function restoreEnvironmentSync(snapshot: EnvironmentSyncSnapshot): void {
  if (snapshot.row === null) return;
  const [syncedAt, status, error, updated, by] = snapshot.row.split('|').map((part) => (part === '<null>' ? null : part));
  queryMasterDb(
    `UPDATE app.HostSyncs SET LastSyncedAt = '${syncedAt}', LastStatus = ${sqlText(status)}, LastError = ${sqlText(error)}, Updated = '${updated}', UpdatedBy = ${sqlText(by)} WHERE HostID_FK = ${snapshot.hostId} AND Area = N'Environment' AND Active = 1`,
  );
}

export interface RecordCounts {
  masterActive: number;
  masterSecrets: number;
  masterSecretsNull: number;
  masterMessaging: number;
  hostRows: number;
  hostSecrets: number;
  hostMessaging: number;
}

export function recordCounts(hostId: number): RecordCounts {
  const [masterActive, masterSecrets, masterSecretsNull, masterMessaging] = queryMasterDb(
    `SELECT CAST(COUNT(*) AS varchar(10)) + '|' + CAST(SUM(CAST(IsSensitive AS int)) AS varchar(10)) + '|' + CAST(SUM(CASE WHEN IsSensitive = 1 AND PropertyValue IS NULL THEN 1 ELSE 0 END) AS varchar(10)) + '|' + CAST(SUM(CASE WHEN GroupName = N'Messaging' THEN 1 ELSE 0 END) AS varchar(10)) FROM app.HostEnvironmentSettings WHERE HostID_FK = ${hostId} AND Active = 1`,
  )!.split('|').map(Number);
  const [hostRows, hostSecrets, hostMessaging] = querySingleValue(
    `SELECT CAST(COUNT(*) AS varchar(10)) + '|' + CAST(SUM(CAST(IsSensitive AS int)) AS varchar(10)) + '|' + CAST(SUM(CASE WHEN GroupName = 'Messaging' THEN 1 ELSE 0 END) AS varchar(10)) FROM app.EnvironmentSetting`,
  )!.split('|').map(Number);
  return { masterActive, masterSecrets, masterSecretsNull, masterMessaging, hostRows, hostSecrets, hostMessaging };
}

export function secretsDifferingFromHost(hostId: number): number {
  if (!env.localSql) throw new Error('LOCAL_SQL_DATABASE is not set.');
  return Number(
    queryMasterDb(
      `SELECT COUNT(*) FROM app.HostEnvironmentSettings m JOIN [${env.localSql.database}].app.EnvironmentSetting h ON h.GroupName = m.GroupName AND ISNULL(h.SubGroupName, '') = ISNULL(m.SubGroupName, '') AND h.PropertyName = m.PropertyName
       WHERE m.HostID_FK = ${hostId} AND m.Active = 1 AND m.IsSensitive = 1 AND h.PropertyValue IS NOT NULL
         AND (m.PropertyValue IS NULL OR m.PropertyValue COLLATE Latin1_General_BIN <> h.PropertyValue COLLATE Latin1_General_BIN)`,
    ),
  );
}

export interface SecretHash {
  key: string;
  hash: string;
}

export function hostSecretHashes(): SecretHash[] {
  return (querySingleValue(
    `SELECT GroupName + ':' + PropertyName + '|' + CONVERT(varchar(64), HASHBYTES('SHA2_256', PropertyValue), 2) FROM app.EnvironmentSetting WHERE IsSensitive = 1 AND PropertyValue IS NOT NULL AND LEN(PropertyValue) > 0`,
  ) ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [key, hash] = line.split('|');
      return { key, hash: hash.toLowerCase() };
    });
}

export const ACTOR_FIELD = /\.updatedBy$/;

export function secretsFoundIn(value: unknown, secrets: SecretHash[], ignore: RegExp | null = ACTOR_FIELD): string[] {
  const paths = stringPaths(value);
  return secrets.flatMap(({ key, hash }) => (paths.get(hash) ?? []).filter((path) => !ignore?.test(path)).map((path) => `${key} at ${path}`));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function stringPaths(value: unknown, path = '$', into = new Map<string, string[]>()): Map<string, string[]> {
  if (typeof value === 'string') {
    for (const hash of new Set([sha256(value), sha256(value.trim())])) {
      into.set(hash, [...(into.get(hash) ?? []), path]);
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => stringPaths(item, `${path}[${i}]`, into));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) stringPaths(item, `${path}.${key}`, into);
  }
  return into;
}

export interface EnvironmentSettingJson {
  settingUuid: string;
  configurationKey: string;
  value: string | null;
  isSensitive: boolean;
  hasValue: boolean;
  differsOnHost: boolean;
  hostValue: string | null;
}

export function settingsOf(view: { groups: { settings: EnvironmentSettingJson[] }[] }): EnvironmentSettingJson[] {
  return view.groups.flatMap((group) => group.settings);
}

export function templateUuid(key: string): string {
  const { group, property } = settingKey(key);
  const uuid = queryMasterDb(
    `SELECT LOWER(CAST(SettingTemplateUUID AS varchar(36))) FROM app.SettingTemplates WHERE Active = 1 AND GroupName = ${sqlText(group)} AND SubGroupName IS NULL AND PropertyName = ${sqlText(property)}`,
  );
  if (uuid === null) throw new Error(`${key} is not in the settings template.`);
  return uuid;
}

export function templateDefault(key: string): string | null {
  const { group, property } = settingKey(key);
  return queryMasterDb(
    `SELECT PropertyValue FROM app.SettingTemplates WHERE Active = 1 AND IsHostSpecific = 0 AND GroupName = ${sqlText(group)} AND SubGroupName IS NULL AND PropertyName = ${sqlText(property)}`,
  );
}

export function effectiveValue(hostId: number, key: string): string | null {
  return masterValue(hostId, key) ?? templateDefault(key);
}

export function sensitiveTemplateCount(): number {
  return Number(queryMasterDb('SELECT COUNT(*) FROM app.SettingTemplates WHERE Active = 1 AND IsSensitive = 1'));
}

export interface TemplateRecordCounts {
  templateKeys: number;
  notInTemplate: number;
  hostRowsUncovered: number;
  hostSecretsUncovered: number;
  hostSecretsNotInTemplate: number;
}

const TEMPLATE_MATCH = `t.Active = 1 AND t.GroupName = h.GroupName AND ISNULL(t.SubGroupName, '') = ISNULL(h.SubGroupName, '') AND t.PropertyName = h.PropertyName`;

export function templateRecordCounts(hostId: number): TemplateRecordCounts {
  if (!env.localSql) throw new Error('LOCAL_SQL_DATABASE is not set.');
  const hostDb = `[${env.localSql.database}].app.EnvironmentSetting`;
  const masterMatch = `m.HostID_FK = ${hostId} AND m.Active = 1 AND m.GroupName = h.GroupName AND ISNULL(m.SubGroupName, '') = ISNULL(h.SubGroupName, '') AND m.PropertyName = h.PropertyName`;
  const [templateKeys, notInTemplate, hostRowsUncovered, hostSecretsUncovered, hostSecretsNotInTemplate] = queryMasterDb(
    `SELECT CONCAT(
       (SELECT COUNT(*) FROM app.SettingTemplates WHERE Active = 1), '|',
       (SELECT COUNT(*) FROM app.HostEnvironmentSettings h WHERE h.HostID_FK = ${hostId} AND h.Active = 1 AND NOT EXISTS (SELECT 1 FROM app.SettingTemplates t WHERE ${TEMPLATE_MATCH})), '|',
       (SELECT COUNT(*) FROM ${hostDb} h WHERE NOT EXISTS (SELECT 1 FROM app.SettingTemplates t WHERE ${TEMPLATE_MATCH}) AND NOT EXISTS (SELECT 1 FROM app.HostEnvironmentSettings m WHERE ${masterMatch})), '|',
       (SELECT COUNT(*) FROM ${hostDb} h WHERE h.IsSensitive = 1 AND NOT EXISTS (SELECT 1 FROM app.HostEnvironmentSettings m WHERE ${masterMatch} AND m.PropertyValue IS NOT NULL)), '|',
       (SELECT COUNT(*) FROM ${hostDb} h WHERE h.IsSensitive = 1 AND NOT EXISTS (SELECT 1 FROM app.SettingTemplates t WHERE ${TEMPLATE_MATCH})))`,
  )!.split('|').map(Number);
  return { templateKeys, notInTemplate, hostRowsUncovered, hostSecretsUncovered, hostSecretsNotInTemplate };
}

export function masterNow(): string {
  return queryMasterDb("SELECT CONVERT(varchar(23), CAST(SYSUTCDATETIME() AS datetime), 126)")!;
}

export function removeRowsCreatedSince(hostId: number, keys: string[], since: string): void {
  for (const key of keys) {
    const { group, property } = settingKey(key);
    queryMasterDb(
      `DELETE app.HostEnvironmentSettings WHERE HostID_FK = ${hostId} AND GroupName = ${sqlText(group)} AND SubGroupName IS NULL AND PropertyName = ${sqlText(property)} AND Created >= '${since}'`,
    );
  }
}

export interface ResendCheckSetting {
  configurationKey: string;
  hasValue: boolean;
  differsOnHost: boolean;
  missingOnHost?: boolean;
}

export function settingsResentBySave(settings: ResendCheckSetting[], except: string[] = []): string[] {
  return settings
    .filter((s) => !except.includes(s.configurationKey) && (s.differsOnHost || (s.missingOnHost && s.hasValue)))
    .map((s) => s.configurationKey);
}
