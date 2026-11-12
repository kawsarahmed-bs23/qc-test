-- QC-912: removes the hosts the HUID @create cases add to HOST_MASTER through Admin (names starting with "E2E QC-912",
-- host keys starting with e2e-qc912), with every row that hangs off them. Hard-deleting them keeps their UUIDs free, so a
-- later run can supply the same "existing host UUID" again. Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE Name LIKE N'E2E QC-912%' OR HostKey LIKE N'e2e-qc912%';

BEGIN TRANSACTION;

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostInviteSigningKeys WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
