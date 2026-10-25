-- QC-775: two throwaway HOST_MASTER hosts for the Features cases (HF-07, HF-12), so the catalog is tried on hosts that
-- are not the target host. Run against MASTER_SQL_DATABASE.
--   e2e-qc775-features  "E2E QC-775 Features"  no API address, no sign-in client: its features live only in HOST_MASTER.
--   e2e-qc775-adopt     "E2E QC-775 Adopt"     API https://localhost:7026/ and no feature rows, so the first open takes
--                                              the host API's current values into HOST_MASTER. The cases only read it.
-- Re-running replaces both hosts; master-qc775-features.remove.sql deletes them with every row that hangs off them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Old TABLE (HostID int PRIMARY KEY);
INSERT @Old SELECT HostID FROM app.Hosts WHERE HostKey IN (N'e2e-qc775-features', N'e2e-qc775-adopt');

BEGIN TRANSACTION;

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Old);

INSERT app.Hosts (Name, DatabaseName, Active, CreatedBy, UpdatedBy, ClientID, UiDomain, ApiDomain, HostOrganisationID, HostKey, ApiBaseUrl)
VALUES
    (N'E2E QC-775 Features', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', NULL, NULL, NULL, 99, N'e2e-qc775-features', NULL),
    (N'E2E QC-775 Adopt', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', NULL, NULL, NULL, 99, N'e2e-qc775-adopt', N'https://localhost:7026/');

COMMIT TRANSACTION;
