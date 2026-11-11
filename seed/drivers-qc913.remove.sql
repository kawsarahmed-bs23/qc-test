-- QC-913: removes what the Vendor Portal invite case (UINV-09 in tests/app/user-invites.spec.ts) left in DRIVERS_SQL_DATABASE
-- for the drivers in $(UserIds) (a comma-separated list of Identity UserUUIDs; pass none when there are none): the host link
-- the accepted invite made (DriverInviteAccepted), and any assignments, trips, tickets, messages, commands, tombstones, device
-- tokens and signed EULAs of those drivers, with their DRIVERS auth.Users rows and roles. One-list schema (DRIVERS 027-030).
-- Prints REMOVED links=<n>;leftLinks=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 one-list migrations (027-030).', 1;

DECLARE @Uuids TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Uuids SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(UserIds)', N',')
WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;

DECLARE @AuthUsers TABLE (Id nvarchar(450) PRIMARY KEY);
IF OBJECT_ID(N'auth.Users', N'U') IS NOT NULL
    INSERT @AuthUsers SELECT Id FROM auth.Users WHERE UserUUID IN (SELECT Id FROM @Uuids);

DECLARE @Links int;

BEGIN TRANSACTION;

DELETE app.Messages WHERE DriverUserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Tickets WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Trips WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverSignedEulas WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Uuids);
SET @Links = @@ROWCOUNT;
IF EXISTS (SELECT 1 FROM @AuthUsers)
BEGIN
    DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @AuthUsers);
    DELETE auth.Users WHERE Id IN (SELECT Id FROM @AuthUsers);
END

COMMIT TRANSACTION;

DECLARE @LeftLinks int = (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Uuids));
PRINT CONCAT('REMOVED links=', @Links, ';leftLinks=', @LeftLinks);
