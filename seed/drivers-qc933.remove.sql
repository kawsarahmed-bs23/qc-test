-- QC-933: removes what drivers-qc933.apply.sql and the change proposal cases left in DRIVERS_SQL_DATABASE for the drivers
-- in $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): their change proposals, messages,
-- commands, tombstones, device tokens, links, settings, Driver accounts and the 'E2E QC-933 Driver %' organisations, then
-- the 'E2E QC-933%' hosts (CreatedBy e2e) and the Wolverine outbox rows that waited for their dead endpoint.
-- Prints 'REMOVED left=<n>', the rows still there afterwards (must be 0).
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
INSERT @Hosts SELECT HostUUID FROM app.Hosts WHERE HostName LIKE N''E2E QC-933%'' AND CreatedBy = N''e2e'';

DECLARE @Orgs TABLE (Id int PRIMARY KEY);
INSERT @Orgs SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N''E2E QC-933 Driver %'';

BEGIN TRANSACTION;

DELETE app.ChangeProposals WHERE DriverUserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Messages WHERE DriverUserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Tickets WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Trips WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Users);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Users) OR HostUUID IN (SELECT Id FROM @Hosts);
DELETE app.Hosts WHERE HostUUID IN (SELECT Id FROM @Hosts);

DELETE r FROM auth.UserToRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.UserUUID IN (SELECT Id FROM @Users);
DELETE app.DriverSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE auth.Users WHERE UserUUID IN (SELECT Id FROM @Users) OR OrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs);

DELETE msg.wolverine_outgoing_envelopes WHERE destination LIKE N''tcp://localhost:6299%'';

COMMIT TRANSACTION;

SELECT CONCAT(N''REMOVED left='',
    (SELECT COUNT(*) FROM app.ChangeProposals WHERE DriverUserUUID IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM auth.Users WHERE UserUUID IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName LIKE N''E2E QC-933 Driver %'')
  + (SELECT COUNT(*) FROM app.Hosts WHERE HostName LIKE N''E2E QC-933%''));', N'@UserIds nvarchar(max)', @UserIds;
