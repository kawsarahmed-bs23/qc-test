-- QC-898: removes what the invite-link cases of tests/33-host-uuids.spec.ts left in DRIVERS_SQL_DATABASE for the drivers in
-- $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): every invite sent to them by UUID or
-- to an e2e.qc898.* email, their mirror rows, commands, sync tombstones, device tokens and host links.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');

BEGIN TRANSACTION;

DELETE app.DriverInvites WHERE InvitedUserID IN (SELECT Id FROM @Users) OR InvitedEmail LIKE N'e2e.qc898.%@quarryconnect.test';
DELETE app.Messages WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.Tickets WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.Trips WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.OrderAssignments WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.DriverCommands WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.SyncTombstones', N'U') IS NOT NULL
    DELETE app.SyncTombstones WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DeviceTokens', N'U') IS NOT NULL
    DELETE app.DeviceTokens WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
