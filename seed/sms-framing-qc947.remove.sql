-- QC-947: removes the framing driver e2e.qc947.framing@quarryconnect.test added by sms-framing-qc947.apply.sql from the host
-- database, with its 'E2E-QC947-SMSFMT' assignment and every message, reply link, trip note, history and mirror row on
-- either. Prints 'REMOVED users=0;assignments=0;messages=0' when nothing is left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail = N'E2E.QC947.FRAMING@QUARRYCONNECT.TEST';

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = N'E2E-QC947-SMSFMT' OR DriverUserID_FK IN (SELECT Id FROM @Users);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE DriverUserID_FK IN (SELECT Id FROM @Users) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges
    WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR UserID_FK IN (SELECT Id FROM @Users);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;

DECLARE @LeftUsers int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail = N'E2E.QC947.FRAMING@QUARRYCONNECT.TEST');
DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes = N'E2E-QC947-SMSFMT');
DECLARE @LeftMessages int = (SELECT COUNT(*) FROM app.Messages WHERE MessageID IN (SELECT Id FROM @Messages));
PRINT CONCAT(N'REMOVED users=', @LeftUsers, N';assignments=', @LeftAssignments, N';messages=', @LeftMessages);
