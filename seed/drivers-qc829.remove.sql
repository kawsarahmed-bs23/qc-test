-- QC-829: removes what drivers-qc829.apply.sql and the sync cases left in DRIVERS_SQL_DATABASE for the drivers in
-- $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): their mirror assignments, trips,
-- tickets and messages, their commands, sync tombstones, device tokens and links, every device token whose DeviceId
-- starts with 'e2e-qc829', then every 'E2E QC-829%' host row with whatever is still attached to it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');

DECLARE @Hosts TABLE (Id int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE Name LIKE N'E2E QC-829%' AND CreatedBy = N'e2e';

BEGIN TRANSACTION;

DELETE app.Messages WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Tickets WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Trips WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.OrderAssignments WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.DriverCommands WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.SyncTombstones WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.DeviceTokens WHERE UserID_FK IN (SELECT Id FROM @Users) OR DeviceId LIKE N'e2e-qc829%';
DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT Id FROM @Hosts);

COMMIT TRANSACTION;
