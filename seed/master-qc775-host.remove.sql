-- QC-775: removes the throwaway host e2e-qc775 added by master-qc775-host.apply.sql, with its allowed addresses,
-- branding, features, settings, sync rows and activity entries. Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey = N'e2e-qc775';

BEGIN TRANSACTION;

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
