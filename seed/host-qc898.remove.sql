-- QC-898: removes everything host-qc898.apply.sql, host-qc898-user.apply.sql and the host UUID cases
-- (tests/33-host-uuids.spec.ts) left in the host database:
--   * the 'e2e-qc898' orders and every assignment on them or of an e2e.qc898 user (the ones the tests made through the API,
--     the copies, the seeded one), with their history, notes, snapshots, messages and driver-mirror rows,
--   * every app.DriverInvites row of the 'E2E QC-898 Vendor' organisation or sent to an e2e.qc898.* email,
--   * every e2e.qc898.*@quarryconnect.test user (seeded, or made by LinkEstablished with Id = the driver's sub) with roles,
--     EULA signatures, claims, sessions, refresh tokens and sign-in history, and the mirror rows of the subs in $(UserIds)
--     (comma-separated, or none),
--   * the two 'E2E QC-898 Truck' organisations and the vendor organisation.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc898';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC898.%@QUARRYCONNECT.TEST';

DECLARE @Subs TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Subs SELECT Id FROM @Users;
INSERT @Subs SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',')
WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none') AND LTRIM(RTRIM(value)) NOT IN (SELECT Id FROM @Users);

DECLARE @Vendors TABLE (Id int PRIMARY KEY);
INSERT @Vendors SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E QC-898 Vendor' AND UpdatedBy = 'e2e-qc898';

DECLARE @Trucks TABLE (Id int PRIMARY KEY);
INSERT @Trucks SELECT OrganisationID FROM auth.Organisations
WHERE ParentOrganisationIdFk IN (SELECT Id FROM @Vendors) AND OrganisationName LIKE N'E2E QC-898 Truck%' AND UpdatedBy = 'e2e-qc898';

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE Notes = @Marker;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE OrderID_FK IN (SELECT Id FROM @Orders) OR DriverUserID_FK IN (SELECT Id FROM @Users)
   OR VendorID_FK IN (SELECT Id FROM @Vendors) OR TruckID_FK IN (SELECT Id FROM @Trucks);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.DriverInvites', N'U') IS NOT NULL
    DELETE app.DriverInvites WHERE VendorID_FK IN (SELECT Id FROM @Vendors) OR TruckID_FK IN (SELECT Id FROM @Trucks)
        OR InvitedEmail LIKE N'e2e.qc898.%@quarryconnect.test';

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Subs);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Subs) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Subs);

UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

IF OBJECT_ID(N'app.DriverSyncTombstones', N'U') IS NOT NULL
    DELETE app.DriverSyncTombstones WHERE DriverUserID_FK IN (SELECT Id FROM @Subs);

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc898.%@quarryconnect.test';
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

DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Trucks);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Vendors);

COMMIT TRANSACTION;
