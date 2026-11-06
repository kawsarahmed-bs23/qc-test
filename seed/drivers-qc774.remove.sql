-- QC-774: removes what drivers-qc774.apply.sql and the driver-invite cases left in DRIVERS_SQL_DATABASE for the drivers in
-- $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): every invite sent to them by UUID or
-- to an e2e.qc774.* email (accepted, declined, cancelled or still open), their mirror rows, commands, sync tombstones and
-- links (to any host), then every 'E2E QC-774%' host row with whatever is still attached to it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');

DECLARE @Hosts TABLE (Id int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE Name LIKE N'E2E QC-774%' AND CreatedBy = N'e2e';

BEGIN TRANSACTION;

DELETE app.DriverInvites WHERE InvitedUserID IN (SELECT Id FROM @Users) OR InvitedEmail LIKE N'e2e.qc774.%@quarryconnect.test'
    OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Messages WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Tickets WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Trips WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.OrderAssignments WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.DriverCommands WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
IF OBJECT_ID(N'app.SyncTombstones', N'U') IS NOT NULL
    DELETE app.SyncTombstones WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
IF OBJECT_ID(N'app.DeviceTokens', N'U') IS NOT NULL
    DELETE app.DeviceTokens WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT Id FROM @Hosts);

COMMIT TRANSACTION;
