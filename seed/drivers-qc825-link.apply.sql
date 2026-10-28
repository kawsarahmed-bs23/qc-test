-- QC-825: links one more throwaway driver $(UserId) to the local host $(HostUuid) in DRIVERS_SQL_DATABASE with
-- SyncRequestedAt NULL, so the resync sweep subscribes it on the host (DMIR-14). drivers-qc825.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = N'$(HostUuid)' AND Active = 1);
IF @HostId IS NULL
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;

DELETE app.DriverHostLinks WHERE UserID_FK = @UserId AND HostID_FK = @HostId;
INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N'e2e', N'e2e');
