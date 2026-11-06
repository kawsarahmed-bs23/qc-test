-- QC-745: removes what the TPL cases add to HOST_MASTER. Run against MASTER_SQL_DATABASE.
--   * every template key in a group starting E2EQC745, and every host's row for such a key;
--   * the throwaway hosts (host keys starting e2e-qc745) with every row that hangs off them.
-- The target host's sync rows, the feature defaults and the activity entries are put back by the spec from its own snapshot,
-- and the rows the host API created in its own database are removed by host-qc745.remove.sql.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc745%';

BEGIN TRANSACTION;

DELETE app.HostEnvironmentSettings WHERE GroupName LIKE N'E2EQC745%';
DELETE app.SettingTemplates WHERE GroupName LIKE N'E2EQC745%';

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
