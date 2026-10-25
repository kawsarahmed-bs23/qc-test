-- QC-775: links the throwaway driver $(UserId) (an Identity sub) to the drivers API host $(HostUuid) in
-- app.DriverHostLinks, the only place that says which hosts a driver may work for. Run against DRIVERS_SQL_DATABASE.
-- drivers-qc775.remove.sql deletes every link made for the users it is given.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = N'$(HostUuid)' AND Active = 1);
IF @HostId IS NULL
    THROW 50001, 'The host is not an active host in the drivers database.', 1;

DELETE app.DriverHostLinks WHERE UserID_FK = @UserId AND HostID_FK = @HostId;
INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N'e2e', N'e2e');
