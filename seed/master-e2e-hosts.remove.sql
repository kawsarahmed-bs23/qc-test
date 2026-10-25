-- QC-742: removes the hosts the @create cases add to HOST_MASTER through Admin (host keys starting with e2e-qc7,
-- e.g. e2e-qc739-* from HM-05 and e2e-qc742-* from HOST-05), with every row that hangs off them. Admin has no host
-- delete, only deactivate, so without this every @create run leaves a deactivated host behind.
-- Run against MASTER_SQL_DATABASE. Since QC-775 Identity keeps no host rows, so nothing is left there.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc7%';

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
