-- QC-937: removes what reply-confirmation-qc937.apply.sql and the reply confirmation cases left in the host database: the
-- 'E2E-QC937-RC <slot>' assignments with their messages (the seeded offer, answers, comments and the confirmation texts),
-- reply links, history, trip notes, pings and mirror changes, and the e2e.qc937.* users.
-- Prints 'REMOVED assignments=0;messages=0;users=0' when nothing is left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC937-RC %';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC937.%@QUARRYCONNECT.TEST';

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages
SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR DriverUserID_FK IN (SELECT Id FROM @Users) OR MessageBody LIKE N'%E2E-QC937-RC %';

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges
    WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;

DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC937-RC %');
DECLARE @LeftMessages int = (SELECT COUNT(*) FROM app.Messages WHERE MessageID IN (SELECT Id FROM @Messages));
DECLARE @LeftUsers int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC937.%@QUARRYCONNECT.TEST');
PRINT CONCAT(N'REMOVED assignments=', @LeftAssignments, N';messages=', @LeftMessages, N';users=', @LeftUsers);
