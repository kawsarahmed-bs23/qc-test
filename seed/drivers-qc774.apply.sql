-- QC-774: in DRIVERS_SQL_DATABASE, gives the throwaway driver $(UserId) a link to a second, throwaway host row
-- $(SecondHostUuid) ('E2E QC-774 Second host', no message endpoint), so DINV-06 can show that a host revoke ends only the
-- revoking host's link. The link to the local host comes from accepting an invite, never from a seed.
-- drivers-qc774.remove.sql deletes the link, the second host and everything the invite cases left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';

BEGIN TRANSACTION;

INSERT app.Hosts (HostUUID, Name, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (N'$(SecondHostUuid)', N'E2E QC-774 Second host', N'https://localhost:7999/', N'drivers.service.e2e-qc774', GETUTCDATE(), GETUTCDATE(), 1, N'e2e', N'e2e', NULL, 1, N'Central Standard Time');
DECLARE @SecondHostId int = SCOPE_IDENTITY();

INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @SecondHostId, N'e2e', N'e2e');

COMMIT TRANSACTION;
