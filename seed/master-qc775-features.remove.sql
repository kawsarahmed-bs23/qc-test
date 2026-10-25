-- QC-775: removes what the Features cases (HF-06…12) add to HOST_MASTER: the throwaway hosts e2e-qc775-features and
-- e2e-qc775-adopt with every row that hangs off them, and the probe catalog feature e2e_qc775_probe with every host's
-- row for it. Run against MASTER_SQL_DATABASE. host-qc775-features.remove.sql removes the probe from the host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey IN (N'e2e-qc775-features', N'e2e-qc775-adopt');

BEGIN TRANSACTION;

DELETE app.HostFeatures WHERE FeatureKey = 'e2e_qc775_probe';
DELETE app.Features WHERE FeatureKey = 'e2e_qc775_probe';

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
