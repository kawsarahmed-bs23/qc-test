-- QC-775: a throwaway host in HOST_MASTER for the Identity host-feed cases (HMI-*), so changing a host's sign-in
-- branding, return addresses or Active flag never touches a real host. Run against MASTER_SQL_DATABASE.
--   HostKey e2e-qc775, client e2e-qc775.web, no host API, return / sign-out address http://localhost:4275/,
--   CORS origin http://localhost:4275, branding "E2E QC-775 Sign-in" with primary colour #7a1f2b.
-- Identity reads it through the Admin API's GET api/identity/hosts and caches the feed for up to 5 minutes.
-- Re-running replaces the host; master-qc775-host.remove.sql deletes it with every row that hangs off it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @HostKey nvarchar(100) = N'e2e-qc775';
DECLARE @Old TABLE (HostID int PRIMARY KEY);
INSERT @Old SELECT HostID FROM app.Hosts WHERE HostKey = @HostKey;

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
VALUES (N'E2E QC-775 Sign-in', N'QuarryConnect_Dev', 1, N'e2e', N'e2e', N'e2e-qc775.web', N'http://localhost:4275', NULL, 99, @HostKey, NULL);

DECLARE @HostId int = SCOPE_IDENTITY();

INSERT app.HostAllowedUrls (HostID_FK, UrlType, Url, CreatedBy, UpdatedBy)
VALUES
    (@HostId, 1, N'http://localhost:4275/', N'e2e', N'e2e'),
    (@HostId, 2, N'http://localhost:4275/', N'e2e', N'e2e'),
    (@HostId, 3, N'http://localhost:4275', N'e2e', N'e2e');

INSERT app.HostBrandings (HostID_FK, DisplayName, PrimaryColor, AccentColor, CreatedBy, UpdatedBy)
VALUES (@HostId, N'E2E QC-775 Sign-in', N'#7a1f2b', N'#f2b134', N'e2e', N'e2e');

COMMIT TRANSACTION;
