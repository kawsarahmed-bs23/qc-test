-- QC-902 part 2: removes what tests/37-account-deletion.spec.ts left in DRIVERS_SQL_DATABASE for the drivers in $(UserIds)
-- (a comma-separated list of UUIDs: the throwaway Identity driver's sub and the fake purge drivers; pass none when there are none):
-- their assignments, trips, tickets, messages, device tokens, links, invites (by InvitedUserID), commands, tombstones and
-- signed EULAs, their auth.Users rows with their roles, their organisations with the app.DriverSettings rows, and the
-- app.DriverDeletions hash rows of those UUIDs. Every 'E2E QC-902 Purge%' organisation and every e2e.qc902.purge.* /
-- e2e.qc902.deletion* user goes too. One-list schema (DRIVERS 027-030): rows are keyed by UserUUID / DriverUserUUID;
-- DriverInvites.InvitedUserID is still the lower-case UUID string.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverDeletions', N'U') IS NULL OR COL_LENGTH(N'app.DriverSettings', N'DeletionRequestedAt') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 deletion migrations (032-033).', 1;
IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50002, 'This DRIVERS database does not have the QC-902 one-list migrations (027-030).', 1;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LOWER(LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');
INSERT @Users
SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users
WHERE (NormalizedEmail LIKE N'E2E.QC902.PURGE.%@QUARRYCONNECT.TEST' OR NormalizedEmail LIKE N'E2E.QC902.DELETION%@QUARRYCONNECT.TEST')
  AND LOWER(CONVERT(nvarchar(36), UserUUID)) NOT IN (SELECT Id FROM @Users);

DECLARE @AuthUsers TABLE (Id nvarchar(450) PRIMARY KEY, OrganisationId int NOT NULL);
INSERT @AuthUsers SELECT Id, OrganisationIdFk FROM auth.Users WHERE LOWER(CONVERT(nvarchar(36), UserUUID)) IN (SELECT Id FROM @Users);

DECLARE @Organisations TABLE (Id int PRIMARY KEY);
INSERT @Organisations
SELECT OrganisationId FROM @AuthUsers
UNION
SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-902 Purge%' AND UpdatedBy = 'e2e';

BEGIN TRANSACTION;

DECLARE @Uuids TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Uuids SELECT DISTINCT TRY_CONVERT(uniqueidentifier, Id) FROM @Users WHERE TRY_CONVERT(uniqueidentifier, Id) IS NOT NULL;

DELETE app.Messages WHERE DriverUserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Tickets WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Trips WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverSignedEulas WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverInvites WHERE InvitedUserID IN (SELECT Id FROM @Users);
DELETE app.DriverDeletions
WHERE UserUUIDHash IN (SELECT HASHBYTES('SHA2_256', CONVERT(varbinary(100), CONVERT(varchar(36), UPPER(Id)))) FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @AuthUsers);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @AuthUsers);
DELETE app.DriverSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Organisations);

COMMIT TRANSACTION;
