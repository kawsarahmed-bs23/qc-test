-- QC-829: in DRIVERS_SQL_DATABASE, links the throwaway driver $(UserId) to
--   * the local host $(HostUuid) with SyncRequestedAt NULL, so the Drivers API's resync sweep asks that host for the
--     driver's work, and
--   * a second, throwaway host row $(SecondHostUuid) ('E2E QC-829 Second host', no message endpoint, dispatch on) that
--     holds no work for the driver, so a sync cursor from the first host can be replayed against it (SYNC-03).
-- The second driver of SYNC-05 gets no link: the move only has to take the job away from the first driver.
-- drivers-qc829.remove.sql deletes the links, every mirror row, command, tombstone and device of the driver, and the second host.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = N'$(HostUuid)' AND Active = 1);
IF @HostId IS NULL
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserID_FK = @UserId;

INSERT app.Hosts (HostUUID, Name, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (N'$(SecondHostUuid)', N'E2E QC-829 Second host', N'https://localhost:7999/', N'drivers.service.e2e-qc829', GETUTCDATE(), GETUTCDATE(), 1, N'e2e', N'e2e', NULL, 1, N'Central Standard Time');
DECLARE @SecondHostId int = SCOPE_IDENTITY();

INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N'e2e', N'e2e');
INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @SecondHostId, N'e2e', N'e2e');

COMMIT TRANSACTION;
