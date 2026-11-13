-- QC-938: removes what drivers-qc938.apply.sql and the Job card header cases left in DRIVERS_SQL_DATABASE for the drivers in
-- $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): their messages, trips, tickets,
-- assignments, commands, tombstones, device tokens and links, then every 'E2E QC-938%' host (CreatedBy e2e) with whatever
-- is still attached to it. Prints 'REMOVED left=<n>', the rows still there afterwards (must be 0).
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 one-list migrations (UserUUID).', 1;

DECLARE @UserIds nvarchar(max) = N'$(UserIds)';

EXEC sp_executesql N'
DECLARE @Users TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Users SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(@UserIds, N'','')
WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;

DECLARE @Hosts TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Hosts SELECT HostUUID FROM app.Hosts WHERE HostName LIKE N''E2E QC-938%'' AND CreatedBy = N''e2e'';

BEGIN TRANSACTION;

DELETE app.Messages WHERE DriverUserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Tickets WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Trips WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts) OR Notes LIKE N''e2e-qc938%'';
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Users);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Hosts WHERE HostUUID IN (SELECT Id FROM @Hosts);

COMMIT TRANSACTION;

SELECT CONCAT(N''REMOVED left='',
    (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N''e2e-qc938%'' OR DriverUserUUID IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM app.Hosts WHERE HostName LIKE N''E2E QC-938%''));', N'@UserIds nvarchar(max)', @UserIds;
