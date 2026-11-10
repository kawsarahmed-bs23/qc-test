-- Removes everything reply-links-qc777.apply.sql added and everything the QC-777 tests wrote on top of it: the order
-- and assignments marked E2E-QC777, every message whose body carries the marker or that points at those assignments
-- (the notify SMS, Status Pings and the reply-link answers), the MessageReplyLinks rows of those messages, and the
-- assignments' history, trip notes, schedule snapshots and driver-mirror change rows. The seed changes no existing
-- row, so nothing is put back. Prints how many marked rows are left (all three must be 0).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC777';

BEGIN TRANSACTION;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments
SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE Notes = @Marker OR OrderID_FK IN (SELECT OrderID FROM app.Orders WHERE Notes = @Marker);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages
SELECT MessageID FROM app.Messages
WHERE MessageBody LIKE N'%' + @Marker + N'%' OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DELETE app.MessageReplyLinks
WHERE MessageID_FK IN (SELECT Id FROM @Messages) OR AnswerMessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR MessageID_FK IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.Orders WHERE Notes = @Marker;

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED orders=', (SELECT COUNT(*) FROM app.Orders WHERE Notes = @Marker),
    ';assignments=', (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes = @Marker),
    ';messages=', (SELECT COUNT(*) FROM app.Messages WHERE MessageBody LIKE N'%' + @Marker + N'%'),
    ';orphanLinks=', (SELECT COUNT(*) FROM app.MessageReplyLinks l WHERE NOT EXISTS (SELECT 1 FROM app.Messages m WHERE m.MessageID = l.MessageID_FK)));
