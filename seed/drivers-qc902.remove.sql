-- QC-902: removes what drivers-qc902.apply.sql, drivers-qc902-account.apply.sql and the settings cases left in
-- DRIVERS_SQL_DATABASE for the drivers in $(UserIds) (a comma-separated list of Identity subs; pass none when there are none):
-- their messages, assignments, commands, tombstones and links, their auth.Users rows with their roles, and their
-- organisations with the app.DriverSettings rows. Every 'E2E QC-902%' organisation goes too.
-- QC-902 one list: UserUUID / DriverUserUUID since DRIVERS migration 027, UserID_FK before (run through sp_executesql).
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverSettings', N'U') IS NULL OR OBJECT_ID(N'auth.Organisations', N'U') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 migrations (022-026).', 1;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LOWER(LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');

DECLARE @AuthUsers TABLE (Id nvarchar(450) PRIMARY KEY, OrganisationId int NOT NULL);
INSERT @AuthUsers SELECT Id, OrganisationIdFk FROM auth.Users WHERE LOWER(CONVERT(nvarchar(36), UserUUID)) IN (SELECT Id FROM @Users);

DECLARE @Organisations TABLE (Id int PRIMARY KEY);
INSERT @Organisations
SELECT OrganisationId FROM @AuthUsers
UNION
SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-902%' AND UpdatedBy = 'e2e';

BEGIN TRANSACTION;

DECLARE @UserIds nvarchar(max) = (SELECT STRING_AGG(Id, N',') FROM @Users);
IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql N'
DECLARE @Ids TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Ids SELECT DISTINCT TRY_CONVERT(uniqueidentifier, value) FROM STRING_SPLIT(ISNULL(@UserIds, N''''), N'','') WHERE TRY_CONVERT(uniqueidentifier, value) IS NOT NULL;
DELETE app.Messages WHERE DriverUserUUID IN (SELECT Id FROM @Ids);
DELETE app.Tickets WHERE UserUUID IN (SELECT Id FROM @Ids);
DELETE app.Trips WHERE UserUUID IN (SELECT Id FROM @Ids);
DELETE app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Ids);
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Ids);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Ids);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Ids);', N'@UserIds nvarchar(max)', @UserIds;
ELSE
    EXEC sp_executesql N'
DECLARE @Ids TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Ids SELECT DISTINCT value FROM STRING_SPLIT(ISNULL(@UserIds, N''''), N'','') WHERE value <> N'''';
DELETE app.Messages WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.Tickets WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.Trips WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.OrderAssignments WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.DriverCommands WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.SyncTombstones WHERE UserID_FK IN (SELECT Id FROM @Ids);
DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT Id FROM @Ids);', N'@UserIds nvarchar(max)', @UserIds;
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @AuthUsers);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @AuthUsers);
DELETE app.DriverSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Organisations);

COMMIT TRANSACTION;
