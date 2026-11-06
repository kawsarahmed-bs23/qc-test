-- QC-745: two throwaway HOST_MASTER hosts that are not ready, laid out the way Admin's host create seeds a new host
-- (HostReadinessService.SeedNewHostAsync): one app.HostFeatures row per active catalog feature from app.Features.DefaultEnabled,
-- one app.HostEnvironmentSettings row for (root):HostOrganisationId holding the host's organisation id, nothing else, ReadyAt NULL.
-- Used because POST api/hosts cannot create a host locally (see TPL-10); the cases read both hosts back by key.
--   e2e-qc745-new    "E2E QC-745 New"     API https://localhost:9/ (nothing listens there, so any call to it would fail and be recorded)
--   e2e-qc745-noapi  "E2E QC-745 No API"  no API address
-- Run against MASTER_SQL_DATABASE. Re-running replaces both; master-qc745.remove.sql deletes them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Old TABLE (HostID int PRIMARY KEY);
INSERT @Old SELECT HostID FROM app.Hosts WHERE HostKey IN (N'e2e-qc745-new', N'e2e-qc745-noapi');

BEGIN TRANSACTION;

DELETE app.ChangeLogs WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostSyncs WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostFeatures WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostEnvironmentSettings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostSettings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostBrandings WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.HostAllowedUrls WHERE HostID_FK IN (SELECT HostID FROM @Old);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Old);

INSERT app.Hosts (Name, DatabaseName, Active, CreatedBy, UpdatedBy, ClientID, UiDomain, ApiDomain, HostOrganisationID, HostKey, ApiBaseUrl, ReadyAt)
VALUES
    (N'E2E QC-745 New', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', N'e2e-qc745.new', N'http://localhost:4295', NULL, 99, N'e2e-qc745-new', N'https://localhost:9/', NULL),
    (N'E2E QC-745 No API', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', N'e2e-qc745.noapi', N'http://localhost:4296', NULL, 99, N'e2e-qc745-noapi', NULL, NULL);

DECLARE @New TABLE (HostID int PRIMARY KEY, HostOrganisationID int);
INSERT @New SELECT HostID, HostOrganisationID FROM app.Hosts WHERE HostKey IN (N'e2e-qc745-new', N'e2e-qc745-noapi');

INSERT app.HostFeatures (HostID_FK, FeatureKey, IsEnabled, CreatedBy, UpdatedBy)
SELECT n.HostID, f.FeatureKey, f.DefaultEnabled, N'e2e', N'e2e' FROM @New n CROSS JOIN app.Features f WHERE f.Active = 1;

INSERT app.HostEnvironmentSettings (HostID_FK, GroupName, SubGroupName, PropertyName, PropertyValue, PropertyType, IsSensitive, IsRestartRequired, Description, CreatedBy, UpdatedBy)
SELECT n.HostID, t.GroupName, t.SubGroupName, t.PropertyName, CAST(n.HostOrganisationID AS nvarchar(20)), t.PropertyType, t.IsSensitive, t.IsRestartRequired, t.Description, N'e2e', N'e2e'
FROM @New n
CROSS JOIN app.SettingTemplates t
WHERE t.Active = 1 AND t.IsHostSpecific = 1 AND t.GroupName = N'(root)' AND t.PropertyName = N'HostOrganisationId';

COMMIT TRANSACTION;
