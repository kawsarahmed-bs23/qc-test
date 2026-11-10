-- QC-775: links the throwaway driver $(UserId) (an Identity sub) to the drivers API host $(HostUuid) in
-- app.DriverHostLinks, the only place that says which hosts a driver may work for. Run against DRIVERS_SQL_DATABASE.
-- drivers-qc775.remove.sql deletes every link made for the users it is given.
-- QC-902 one list: a DRIVERS database with migrations 027-030 keys links by UserUUID / HostUUID; an older one by
-- UserID_FK / HostID_FK. The statements run through sp_executesql so each schema only compiles its own.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The host is not an active host in the drivers database.', 1;

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
