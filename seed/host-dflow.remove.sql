-- DFLOW: removes what tests/drivers/driver-flows.spec.ts left on the host: every e2e.dflow.*@example.com host user (with invites,
-- notifications, roles, EULA signatures, sessions and driver-mirror rows), the 'e2e-dflow' assignments (and their trips, GPS
-- points, tickets with flags and history, messages, notes, history), ticket batches made after $(BatchMark) that no ticket uses,
-- the 'e2e-dflow order' orders, and the 'E2E DFLOW Truck' / 'E2E DFLOW Vendor' organisations.
-- Prints REMOVED users=<n>;invites=<n>;notifications=<n>;left=<n>;leftInvites=<n>;leftNotifications=<n>;leftOrganisations=<n>;leftAssignments=<n>;leftOrders=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @BatchMark int = $(BatchMark);

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.DFLOW.%@EXAMPLE.COM' OR NormalizedUserName LIKE N'E2E.DFLOW.%@EXAMPLE.COM';

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-dflow%' OR DriverUserID_FK IN (SELECT Id FROM @Users);
INSERT @Assignments SELECT a.OrderAssignmentID FROM app.OrderAssignments a
WHERE (a.OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR a.ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments))
  AND a.OrderAssignmentID NOT IN (SELECT Id FROM @Assignments);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id int PRIMARY KEY);
INSERT @Tickets SELECT TicketID FROM app.Tickets WHERE TripID_FK IN (SELECT Id FROM @Trips);
INSERT @Tickets SELECT TicketID_FK FROM app.Trips
WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL AND TicketID_FK NOT IN (SELECT Id FROM @Tickets);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Vendors TABLE (Id int PRIMARY KEY);
INSERT @Vendors SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E DFLOW Vendor' AND UpdatedBy = 'e2e-dflow';
DECLARE @Trucks TABLE (Id int PRIMARY KEY);
INSERT @Trucks SELECT OrganisationID FROM auth.Organisations
WHERE ParentOrganisationIdFk IN (SELECT Id FROM @Vendors) AND OrganisationName LIKE N'E2E DFLOW Truck%' AND UpdatedBy = 'e2e-dflow';

DECLARE @UserCount int = (SELECT COUNT(*) FROM @Users);
DECLARE @InviteCount int = 0;
DECLARE @NotificationCount int;

BEGIN TRANSACTION;

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Trips SET TicketID_FK = NULL WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL;
IF OBJECT_ID(N'app.TicketFlags', N'U') IS NOT NULL
    DELETE app.TicketFlags WHERE TicketID_FK IN (SELECT Id FROM @Tickets);
DELETE app.TicketHistory WHERE TicketID_FK IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE TicketID IN (SELECT Id FROM @Tickets);
DELETE app.TicketBatches
WHERE TicketBatchID > @BatchMark AND NOT EXISTS (SELECT 1 FROM app.Tickets t WHERE t.TicketBatchID_FK = app.TicketBatches.TicketBatchID);

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

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE Notes = N'e2e-dflow order';
DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
IF OBJECT_ID(N'app.DispatchScheduleSnapshots', N'U') IS NOT NULL
    DELETE app.DispatchScheduleSnapshots WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders) AND NOT EXISTS (SELECT 1 FROM app.OrderAssignments a WHERE a.OrderID_FK = app.Orders.OrderID)
    AND NOT EXISTS (SELECT 1 FROM app.Trips t WHERE t.OrderID_FK = app.Orders.OrderID);

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
BEGIN
    DELETE app.UserInvites WHERE UserID_FK IN (SELECT Id FROM @Users) OR InvitedEmail LIKE N'e2e.dflow.%@example.com';
    SET @InviteCount = @@ROWCOUNT;
END

DELETE auth.SystemNotifications
WHERE NotifcationTo LIKE N'%e2e.dflow.%@example.com%'
   OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.dflow.%@example.com%');
SET @NotificationCount = @@ROWCOUNT;

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.UserSettings', N'U') IS NOT NULL
    DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.dflow.%@example.com';
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

DECLARE @Left int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.DFLOW.%@EXAMPLE.COM' OR NormalizedUserName LIKE N'E2E.DFLOW.%@EXAMPLE.COM');
DECLARE @LeftInvites int = 0;
IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    SET @LeftInvites = (SELECT COUNT(*) FROM app.UserInvites WHERE InvitedEmail LIKE N'e2e.dflow.%@example.com');
DECLARE @LeftNotifications int = (
    SELECT COUNT(*) FROM auth.SystemNotifications
    WHERE NotifcationTo LIKE N'%e2e.dflow.%@example.com%'
       OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.dflow.%@example.com%'));
DECLARE @LeftOrganisations int = (SELECT COUNT(*) FROM auth.Organisations WHERE UpdatedBy = 'e2e-dflow');
DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-dflow%');
DECLARE @LeftOrders int = (SELECT COUNT(*) FROM app.Orders WHERE Notes = N'e2e-dflow order');
PRINT CONCAT('REMOVED users=', @UserCount, ';invites=', @InviteCount, ';notifications=', @NotificationCount, ';left=', @Left,
    ';leftInvites=', @LeftInvites, ';leftNotifications=', @LeftNotifications, ';leftOrganisations=', @LeftOrganisations,
    ';leftAssignments=', @LeftAssignments, ';leftOrders=', @LeftOrders);
