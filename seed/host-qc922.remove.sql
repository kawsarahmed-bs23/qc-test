-- QC-922: removes what host-qc922.apply.sql and the truck-number cases (tests/app/truck-number.spec.ts) left in the host
-- database:
--   * every 'e2e-qc922' assignment and every assignment of an 'E2E QC-922 %' organisation, with their messages (and reply
--     links), trips, history, notes and schedule snapshots,
--   * every e2e.qc922.*@quarryconnect.test user with roles, EULA signatures, sessions, tokens, audit rows and sign-in history,
--   * the 'E2E QC-922 %' organisations (the seeded vendors and truck, and the trucks the Host and Vendor Portal forms create)
--     with their VendorSettings / TruckSettings rows and the location and address rows the truck forms save for them.
-- It also drops the temporary IsInvestmentFirm default host-qc922.apply.sql may add (DF_E2E_QC922_IsInvestmentFirm).
-- Truck numbers the cases change on trucks they did not create are put back by the spec itself, not here.
-- Prints 'REMOVED left=<n>' with the number of e2e-qc922 users, organisations and assignments still there (0 when clean).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC922.%@QUARRYCONNECT.TEST';

DECLARE @Orgs TABLE (Id int PRIMARY KEY);
INSERT @Orgs SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-922 %';

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE Notes LIKE N'e2e-qc922%' OR VendorID_FK IN (SELECT Id FROM @Orgs) OR TruckID_FK IN (SELECT Id FROM @Orgs) OR DriverUserID_FK IN (SELECT Id FROM @Users);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users) OR VendorID_FK IN (SELECT Id FROM @Orgs);

DECLARE @OrgAddresses TABLE (Id int PRIMARY KEY);
INSERT @OrgAddresses SELECT DISTINCT AddressID_FK FROM app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users);

IF OBJECT_ID(N'app.MessageReplyLinks', N'U') IS NOT NULL
    DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.DispatchScheduleSnapshots', N'U') IS NOT NULL
    DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripID IN (SELECT Id FROM @Trips);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL
WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments) OR OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.AuditChanges', N'U') IS NOT NULL
    DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc922.%@quarryconnect.test';
IF OBJECT_ID(N'auth.PasswordHistories', N'U') IS NOT NULL
    DELETE auth.PasswordHistories WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.UserLogins', N'U') IS NOT NULL
    DELETE auth.UserLogins WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE app.Addresses WHERE AddressID IN (SELECT Id FROM @OrgAddresses)
  AND NOT EXISTS (SELECT 1 FROM app.OrganisationAddresses oa WHERE oa.AddressID_FK = app.Addresses.AddressID)
  AND NOT EXISTS (SELECT 1 FROM app.JobAddresses ja WHERE ja.AddressID_FK = app.Addresses.AddressID);
DELETE auth.OrganisationLocations WHERE OrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE app.TruckSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE app.VendorSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
IF OBJECT_ID(N'app.CustomerSettings', N'U') IS NOT NULL
    DELETE app.CustomerSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs) AND ParentOrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs);

COMMIT TRANSACTION;

IF OBJECT_ID(N'auth.DF_E2E_QC922_IsInvestmentFirm', N'D') IS NOT NULL
    ALTER TABLE auth.Organisations DROP CONSTRAINT DF_E2E_QC922_IsInvestmentFirm;

SELECT CONCAT('REMOVED left=',
    (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC922.%@QUARRYCONNECT.TEST')
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-922 %')
  + (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc922%'));
