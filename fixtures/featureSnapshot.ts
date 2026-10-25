import { queryMasterDb, querySingleValue } from './localDb';

export interface FeatureSnapshot {
  hostId: number;
  organisationId: number;
  lastChangeLogId: number;
  table: string;
}

export function masterHostId(uuid: string): number {
  const id = queryMasterDb(`SELECT HostID FROM app.Hosts WHERE HostUUID = '${uuid}'`);
  if (id === null) throw new Error(`Host ${uuid} is not in HOST_MASTER.`);
  return Number(id);
}

export function hostOrganisationId(uuid: string): number {
  return Number(queryMasterDb(`SELECT HostOrganisationID FROM app.Hosts WHERE HostUUID = '${uuid}'`));
}

export function snapshotHostFeatures(uuid: string): FeatureSnapshot {
  const snapshot: FeatureSnapshot = {
    hostId: masterHostId(uuid),
    organisationId: hostOrganisationId(uuid),
    lastChangeLogId: Number(queryMasterDb('SELECT ISNULL(MAX(ChangeLogID), 0) FROM app.ChangeLogs')),
    table: `e2e_qc775_${Date.now().toString(36)}`,
  };
  const { hostId, organisationId, table } = snapshot;
  queryMasterDb(`SELECT * INTO tempdb.dbo.${table}_mf FROM app.HostFeatures WHERE HostID_FK = ${hostId}; SELECT * INTO tempdb.dbo.${table}_ms FROM app.HostSyncs WHERE HostID_FK = ${hostId}`);
  querySingleValue(`SELECT * INTO tempdb.dbo.${table}_hf FROM app.HostFeatures WHERE OrganisationID_FK = ${organisationId}`);
  return snapshot;
}

export function restoreHostFeatures(snapshot: FeatureSnapshot, actors: string[]): void {
  const { hostId, organisationId, table, lastChangeLogId } = snapshot;
  const who = actors.map((actor) => `N'${actor.replace(/'/g, "''")}'`).join(', ');
  queryMasterDb(`
    DELETE app.HostFeatures WHERE HostID_FK = ${hostId} AND HostFeatureID NOT IN (SELECT HostFeatureID FROM tempdb.dbo.${table}_mf);
    UPDATE t SET IsEnabled = s.IsEnabled, Active = s.Active, Updated = s.Updated, UpdatedBy = s.UpdatedBy
      FROM app.HostFeatures t JOIN tempdb.dbo.${table}_mf s ON s.HostFeatureID = t.HostFeatureID;
    DELETE app.HostSyncs WHERE HostID_FK = ${hostId} AND HostSyncID NOT IN (SELECT HostSyncID FROM tempdb.dbo.${table}_ms);
    UPDATE t SET LastSyncedAt = s.LastSyncedAt, LastStatus = s.LastStatus, LastError = s.LastError, Updated = s.Updated, Active = s.Active, UpdatedBy = s.UpdatedBy
      FROM app.HostSyncs t JOIN tempdb.dbo.${table}_ms s ON s.HostSyncID = t.HostSyncID;
    DELETE app.ChangeLogs WHERE ChangeLogID > ${lastChangeLogId} AND HostID_FK = ${hostId} AND CreatedBy IN (${who});
    DROP TABLE tempdb.dbo.${table}_mf; DROP TABLE tempdb.dbo.${table}_ms;`);
  querySingleValue(`
    DELETE app.HostFeatures WHERE OrganisationID_FK = ${organisationId} AND HostFeatureID NOT IN (SELECT HostFeatureID FROM tempdb.dbo.${table}_hf);
    UPDATE t SET Enabled = s.Enabled, UpdatedBy = s.UpdatedBy, Updated = s.Updated
      FROM app.HostFeatures t JOIN tempdb.dbo.${table}_hf s ON s.HostFeatureID = t.HostFeatureID;
    DROP TABLE tempdb.dbo.${table}_hf;`);
}

export interface CatalogEntry {
  key: string;
  label: string;
}

export function featureCatalog(): CatalogEntry[] {
  const rows = queryMasterDb(`SELECT FeatureKey + '|' + Label FROM app.Features WHERE Active = 1 ORDER BY SortOrder, FeatureKey`);
  return (rows ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
    const [key, ...label] = line.split('|');
    return { key, label: label.join('|') };
  });
}

export function masterFeatureFlags(hostId: number): Record<string, boolean> {
  const rows = queryMasterDb(`SELECT FeatureKey + '=' + CAST(IsEnabled AS varchar(1)) FROM app.HostFeatures WHERE HostID_FK = ${hostId} AND Active = 1`);
  return Object.fromEntries((rows ?? '').split(/\r?\n/).filter(Boolean).map((pair) => {
    const [key, flag] = pair.split('=');
    return [key, flag === '1'];
  }));
}

export function hostDbFeatureFlags(organisationId: number): Record<string, boolean> {
  const rows = querySingleValue(`SELECT FeatureKey + '=' + CAST(CAST(Enabled AS int) AS varchar(1)) FROM app.HostFeatures WHERE OrganisationID_FK = ${organisationId}`);
  return Object.fromEntries((rows ?? '').split(/\r?\n/).filter(Boolean).map((pair) => {
    const [key, flag] = pair.split('=');
    return [key, flag === '1'];
  }));
}

export function featuresSync(hostId: number): { status: string; syncedAt: string } | null {
  const row = queryMasterDb(
    `SELECT LastStatus + '|' + ISNULL(CONVERT(varchar(30), LastSyncedAt, 126), '') FROM app.HostSyncs WHERE HostID_FK = ${hostId} AND Area = N'Features' AND Active = 1`,
  );
  if (row === null) return null;
  const [status, syncedAt] = row.split('|');
  return { status, syncedAt };
}
