-- QC-930: removes what host-qc930.apply.sql and the SMS routing cases (tests/app/sms-routing.spec.ts) left in the host database:
--   * every assignment on the 'e2e-qc930' orders and every assignment whose Notes start 'e2e-qc930' (the seeded edit row, the
--     offers the cases save and the copies of them), with their messages (and the messages of the e2e.qc930.* drivers), reply
--     links, history, trips, notes, pings and driver-mirror rows, then the orders with their history,
--   * the e2e.qc930.*@quarryconnect.test users with their app.UserSettings rows, roles, sessions and audit rows,
--   * the 'E2E QC-930 %' organisations with their VendorSettings / TruckSettings,
--   * app.SmsOptOuts rows of the three throwaway phones (+15125559301..3).
-- Prints 'REMOVED left=<n>' with the number of QC-930 assignments, messages, users, settings rows and organisations still there.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE Notes = N'e2e-qc930';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC930.%@QUARRYCONNECT.TEST';

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE OrderID_FK IN (SELECT Id FROM @Orders) OR Notes LIKE N'e2e-qc930%' OR DriverUserID_FK IN (SELECT Id FROM @Users);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users) OR MessageBody LIKE N'%E2E-QC930%';

DECLARE @Orgs TABLE (Id int PRIMARY KEY);
INSERT @Orgs SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-930 %';

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges
    WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL
WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments)
   OR OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.AuditChanges', N'U') IS NOT NULL
    DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
UPDATE app.VendorSettings SET DispatchContactUserID_FK = NULL WHERE DispatchContactUserID_FK IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE app.TruckSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE app.VendorSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE auth.OrganisationLocations WHERE OrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs) AND ParentOrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs);

IF OBJECT_ID(N'app.SmsOptOuts', N'U') IS NOT NULL
    DELETE app.SmsOptOuts WHERE PhoneNumber IN (N'+15125559301', N'+15125559302', N'+15125559303');

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED left=',
    (SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments) OR Notes LIKE N'e2e-qc930%')
  + (SELECT COUNT(*) FROM app.Messages WHERE MessageID IN (SELECT Id FROM @Messages))
  + (SELECT COUNT(*) FROM app.Orders WHERE Notes = N'e2e-qc930')
  + (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC930.%@QUARRYCONNECT.TEST')
  + (SELECT COUNT(*) FROM app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-930 %'));
