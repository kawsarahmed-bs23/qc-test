-- QC-827: removes what host-qc827.apply.sql and the bill-rate cases (tests/39-bill-rates.spec.ts) left in the host database:
--   * every assignment of the 'e2e-qc827' order or of the 'E2E QC-827 Vendor' (and any assignment a reassignment linked to
--     them), with their trips, GPS points, tickets, messages (with reply links), notes, history and schedule snapshots,
--   * the 'e2e-qc827' order and job, with the job's history, rates (and rate history) and addresses, and every
--     'E2E QC-827 Delivery' address the job saves created for the customer (with its organisation-address link),
--   * the DeliverySite address type when this run added it (CreatedBy 'e2e-qc827'),
--   * every e2e.qc827.*@quarryconnect.test user with roles, EULA signatures, sessions, tokens and sign-in history,
--   * the vendor's app.VendorSettings row, the 'E2E QC-827 Truck' and the 'E2E QC-827 Vendor' organisations (UpdatedBy is
--     'e2e-qc827' from the seed, or the e2e.qc827 admin once the Edit Vendor page saved it).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc827';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC827.%@QUARRYCONNECT.TEST';

DECLARE @Vendors TABLE (Id int PRIMARY KEY);
INSERT @Vendors SELECT OrganisationID FROM auth.Organisations
WHERE OrganisationName = N'E2E QC-827 Vendor' AND (UpdatedBy = 'e2e-qc827' OR UpdatedBy LIKE N'e2e.qc827.%@quarryconnect.test');

DECLARE @Trucks TABLE (Id int PRIMARY KEY);
INSERT @Trucks SELECT OrganisationID FROM auth.Organisations
WHERE ParentOrganisationIdFk IN (SELECT Id FROM @Vendors) AND OrganisationName = N'E2E QC-827 Truck';

DECLARE @Jobs TABLE (Id int PRIMARY KEY);
INSERT @Jobs SELECT JobID FROM app.Jobs WHERE JobNotes = @Marker;

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE JobID_FK IN (SELECT Id FROM @Jobs);

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE OrderID_FK IN (SELECT Id FROM @Orders) OR VendorID_FK IN (SELECT Id FROM @Vendors) OR DriverUserID_FK IN (SELECT Id FROM @Users);
INSERT @Assignments SELECT a.OrderAssignmentID FROM app.OrderAssignments a
WHERE (a.OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR a.ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments))
  AND a.OrderAssignmentID NOT IN (SELECT Id FROM @Assignments);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR OrderID_FK IN (SELECT Id FROM @Orders);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users);

DECLARE @Addresses TABLE (Id int PRIMARY KEY);
INSERT @Addresses SELECT AddressID FROM app.Addresses WHERE AddressName = N'E2E QC-827 Delivery';

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Trips SET TicketID_FK = NULL WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL;
DELETE app.Tickets WHERE TripID_FK IN (SELECT Id FROM @Trips);

IF OBJECT_ID(N'app.MessageReplyLinks', N'U') IS NOT NULL
    DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);

DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.DispatchScheduleSnapshots', N'U') IS NOT NULL
    DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripID IN (SELECT Id FROM @Trips);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL
WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments) OR OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

DELETE app.JobHistory WHERE JobID_FK IN (SELECT Id FROM @Jobs);
DELETE app.JobRateHistory WHERE JobRateID_FK IN (SELECT JobRateID FROM app.JobRates WHERE JobID_FK IN (SELECT Id FROM @Jobs));
DELETE app.JobRates WHERE JobID_FK IN (SELECT Id FROM @Jobs);
DELETE app.JobAddresses WHERE JobID_FK IN (SELECT Id FROM @Jobs);
DELETE app.Jobs WHERE JobID IN (SELECT Id FROM @Jobs);

DELETE app.OrganisationAddresses WHERE AddressID_FK IN (SELECT Id FROM @Addresses);
DELETE app.Addresses WHERE AddressID IN (SELECT Id FROM @Addresses);
DELETE app.List_AddressTypes WHERE AddressTypeName = N'DeliverySite' AND CreatedBy = @Marker;

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc827.%@quarryconnect.test';
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

DELETE app.VendorSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Vendors);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Trucks);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Vendors);

COMMIT TRANSACTION;
