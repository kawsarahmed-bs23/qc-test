-- QC-947: removes what reply-page-qc947.apply.sql and the reply-page cases left in the host database: the
-- 'E2E-QC947-RP <slot>' assignments with their messages (the seeded SMS, the answers and comments the page sent, system
-- notices), reply links, history, trip notes, shared-location pings and mirror changes; the inbound keyword texts whose
-- Twilio sid starts with $(SidPrefix) with the system notices that answer them; and the e2e.qc947.* host users.
-- Prints 'REMOVED assignments=0;messages=0;users=0' when nothing is left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @SidPrefix nvarchar(40) = N'$(SidPrefix)';
IF LEN(@SidPrefix) < 6
    THROW 50001, 'The SMS sid prefix is too short.', 1;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC947-RP %';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC947.%@QUARRYCONNECT.TEST';

DECLARE @Keywords TABLE (Id int PRIMARY KEY);
INSERT @Keywords SELECT MessageID FROM app.Messages WHERE TwilioMessageSid LIKE @SidPrefix + N'%';

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages
SELECT MessageID FROM app.Messages
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments)
   OR DriverUserID_FK IN (SELECT Id FROM @Users)
   OR MessageBody LIKE N'%E2E-QC947-RP %'
   OR MessageID IN (SELECT Id FROM @Keywords)
   OR ReplyToMessageID_FK IN (SELECT Id FROM @Keywords);

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges
    WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages) AND MessageID NOT IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages) AND ReplyToMessageID_FK IS NOT NULL;
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;

DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC947-RP %');
DECLARE @LeftMessages int = (SELECT COUNT(*) FROM app.Messages WHERE MessageID IN (SELECT Id FROM @Messages));
DECLARE @LeftUsers int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC947.%@QUARRYCONNECT.TEST');
PRINT CONCAT(N'REMOVED assignments=', @LeftAssignments, N';messages=', @LeftMessages, N';users=', @LeftUsers);
