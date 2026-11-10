-- QC-829 (host API): removes everything host-qc829h.apply.sql added to the host database for e2e.qc829h.*@quarryconnect.test
-- users, and everything the host driver sync cases (tests/27-host-driver-sync.spec.ts) made from it: command receipts, the
-- 'e2e-qc829h' orders and their assignments (including the voided one and the one moved to the second driver), trips, GPS
-- points, tickets (with their history), messages, notes and history rows, then the auth.Users rows with their roles,
-- sign-in history, refresh tokens and sessions. Deleting assignments and tickets fires the QC-829 TR_*_DriverSync triggers,
-- so the users' app.DriverSyncTombstones rows are deleted last.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc829h';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC829H.%@QUARRYCONNECT.TEST';

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT DISTINCT o.OrderID FROM app.Orders o
WHERE o.Notes = @Marker AND (o.OrderID IN (SELECT OrderID_FK FROM app.OrderAssignments WHERE DriverUserID_FK IN (SELECT Id FROM @Users))
    OR NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.OrderID_FK = o.OrderID));

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE DriverUserID_FK IN (SELECT Id FROM @Users) OR OrderID_FK IN (SELECT Id FROM @Orders);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id int PRIMARY KEY);
INSERT @Tickets SELECT TicketID FROM app.Tickets
WHERE TripID_FK IN (SELECT Id FROM @Trips)
   OR TicketID IN (SELECT TicketID_FK FROM app.Trips WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL)
   OR UserID_FK IN (SELECT Id FROM @Users);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Trips SET TicketID_FK = NULL WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL;
DELETE app.TicketHistory WHERE TicketID_FK IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE TicketID IN (SELECT Id FROM @Tickets);
DELETE app.TicketBatches WHERE UserID_FK IN (SELECT Id FROM @Users);

UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);

DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripID IN (SELECT Id FROM @Trips);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

IF OBJECT_ID(N'app.DriverSyncTombstones', N'U') IS NOT NULL
    DELETE app.DriverSyncTombstones WHERE DriverUserID_FK IN (SELECT Id FROM @Users);

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users);
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

COMMIT TRANSACTION;
