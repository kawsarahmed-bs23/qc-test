-- QC-931: removes what host-qc931.apply.sql and the AVAIL cases left in the host database: the 'e2e-qc931' messages (seeded questions
-- and answers), every availability question (MessageType 60, 70, 80) sent to $(DriverIds) after message $(AfterMessageId) with the
-- replies to them, their reply links, driver-mirror rows, and the 'e2e-qc931' orders with any assignment on them.
-- $(DriverIds) is a comma-separated list of auth.Users Ids. Prints 'REMOVED messages=0;links=0;orders=0;assignments=0' when nothing is left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc931';
DECLARE @After int = $(AfterMessageId);
DECLARE @Drivers TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Drivers SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(DriverIds)', N',') WHERE LTRIM(RTRIM(value)) <> N'';

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE Notes = @Marker;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE OrderID_FK IN (SELECT Id FROM @Orders);

DECLARE @Questions TABLE (Id int PRIMARY KEY);
INSERT @Questions SELECT MessageID FROM app.Messages
WHERE CreatedBy = @Marker OR (MessageID > @After AND MessageType IN (60, 70, 80) AND DriverUserID_FK IN (SELECT Id FROM @Drivers));

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages
WHERE MessageID IN (SELECT Id FROM @Questions) OR ReplyToMessageID_FK IN (SELECT Id FROM @Questions)
   OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Messages SET ReplyToMessageID_FK = NULL WHERE ReplyToMessageID_FK IN (SELECT Id FROM @Messages) AND MessageID NOT IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages) AND ReplyToMessageID_FK IS NOT NULL;
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.OrderHistory', N'U') IS NOT NULL
    DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

COMMIT TRANSACTION;

DECLARE @LeftMessages int = (SELECT COUNT(*) FROM app.Messages WHERE MessageID IN (SELECT Id FROM @Messages));
DECLARE @LeftLinks int = (SELECT COUNT(*) FROM app.MessageReplyLinks WHERE MessageID_FK IN (SELECT Id FROM @Messages));
DECLARE @LeftOrders int = (SELECT COUNT(*) FROM app.Orders WHERE Notes = @Marker);
DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments));
PRINT CONCAT(N'REMOVED messages=', @LeftMessages, N';links=', @LeftLinks, N';orders=', @LeftOrders, N';assignments=', @LeftAssignments);
