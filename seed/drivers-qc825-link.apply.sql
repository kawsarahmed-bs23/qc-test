-- QC-825: links one more throwaway driver $(UserId) to the local host $(HostUuid) in DRIVERS_SQL_DATABASE with
-- SyncRequestedAt NULL, so the resync sweep subscribes it on the host (DMIR-14). drivers-qc825.remove.sql deletes it.
-- QC-902 one list: UserUUID / HostUUID since DRIVERS migration 027, UserID_FK / HostID_FK before (run through sp_executesql).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql
        N'DELETE app.DriverHostLinks WHERE UserUUID = @UserId AND HostUUID = @HostUuid;
          INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy) VALUES (@UserId, @HostUuid, N''e2e'', N''e2e'');',
        N'@UserId nvarchar(450), @HostUuid uniqueidentifier', @UserId, @HostUuid;
ELSE
    EXEC sp_executesql
        N'DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1);
          DELETE app.DriverHostLinks WHERE UserID_FK = @UserId AND HostID_FK = @HostId;
          INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N''e2e'', N''e2e'');',
        N'@UserId nvarchar(450), @HostUuid uniqueidentifier', @UserId, @HostUuid;
