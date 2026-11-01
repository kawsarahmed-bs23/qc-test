-- QC-744: two throwaway HOST_MASTER hosts, so the cases can try a save that cannot reach a host, or a host with no API
-- address, without ever changing the target host's ApiBaseUrl. Run against MASTER_SQL_DATABASE.
--   e2e-qc744-unreachable  "E2E QC-744 Unreachable"  API https://localhost:9/ (nothing listens there).
--   e2e-qc744-no-api       "E2E QC-744 No API"       no API address, so saves stay in HOST_MASTER.
--   Features (both): every catalog feature, all off.
--   Environment (both): two non-secret rows (DispatchSnapshot:RateLimitPermitsPerHour = 60, Jobs:ExpiryGraceDays = 7) and
--   one sensitive row E2E:ProbeSecret holding a made-up value, so the page can be checked for never showing a secret.
-- Re-running replaces both hosts; master-qc744-host.remove.sql deletes them with every row that hangs off them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Old TABLE (HostID int PRIMARY KEY);
INSERT @Old SELECT HostID FROM app.Hosts WHERE HostKey IN (N'e2e-qc744-unreachable', N'e2e-qc744-no-api');

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
    (N'E2E QC-744 Unreachable', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', NULL, NULL, NULL, 99, N'e2e-qc744-unreachable', N'https://localhost:9/'),
    (N'E2E QC-744 No API', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', NULL, NULL, NULL, 99, N'e2e-qc744-no-api', NULL);

DECLARE @New TABLE (HostID int PRIMARY KEY);
INSERT @New SELECT HostID FROM app.Hosts WHERE HostKey IN (N'e2e-qc744-unreachable', N'e2e-qc744-no-api');

INSERT app.HostFeatures (HostID_FK, FeatureKey, IsEnabled, CreatedBy, UpdatedBy)
SELECT n.HostID, f.FeatureKey, 0, N'e2e', N'e2e' FROM @New n CROSS JOIN app.Features f WHERE f.Active = 1;

INSERT app.HostEnvironmentSettings (HostID_FK, GroupName, SubGroupName, PropertyName, PropertyValue, PropertyType, IsSensitive, IsRestartRequired, Description, CreatedBy, UpdatedBy)
SELECT n.HostID, v.GroupName, NULL, v.PropertyName, v.PropertyValue, v.PropertyType, v.IsSensitive, v.IsRestartRequired, N'E2E QC-744 probe', N'e2e', N'e2e'
FROM @New n
CROSS JOIN (VALUES
    (N'DispatchSnapshot', N'RateLimitPermitsPerHour', N'60', N'int', 0, 1),
    (N'Jobs', N'ExpiryGraceDays', N'7', N'int', 0, 0),
    (N'E2E', N'ProbeSecret', N'e2e-qc744-made-up-secret', N'string', 1, 0)
) v (GroupName, PropertyName, PropertyValue, PropertyType, IsSensitive, IsRestartRequired);

COMMIT TRANSACTION;
