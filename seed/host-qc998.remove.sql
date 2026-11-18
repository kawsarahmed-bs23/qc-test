-- QC-998 (host API): removes what tests/drivers/host-change-sync.spec.ts made on the host: the 'e2e-qc998' assignments,
-- their trips, GPS points, the tickets on those trips and the duplicate tickets the spec copied (TicketNumber 'QC998-%',
-- with their flags and history), messages (with reply links), notes, history and schedule snapshots, the ticket batches
-- made after $(BatchMark) that no ticket uses any more, and the 'e2e-qc998 order' order (with its history).
-- Jobs, trucks and users are only read; the QC-933 throwaway users are removed by host-qc933.remove.sql.
-- The ticket images the host copied stay in the host's S3 bucket.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @BatchMark int = $(BatchMark);

DECLARE @Orders TABLE (Id int PRIMARY KEY);
INSERT @Orders SELECT OrderID FROM app.Orders WHERE Notes = N'e2e-qc998 order';

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc998%' OR OrderID_FK IN (SELECT Id FROM @Orders);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id int PRIMARY KEY);
INSERT @Tickets SELECT TicketID FROM app.Tickets WHERE TripID_FK IN (SELECT Id FROM @Trips) OR TicketNumber LIKE N'QC998-%';
INSERT @Tickets SELECT TicketID_FK FROM app.Trips
WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL AND TicketID_FK NOT IN (SELECT Id FROM @Tickets);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

BEGIN TRANSACTION;

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Trips SET TicketID_FK = NULL WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL;

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
    DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Trips WHERE TripID IN (SELECT Id FROM @Trips);
UPDATE app.OrderAssignments SET OriginalAssignmentID_FK = NULL, ReassignedToAssignmentID_FK = NULL
WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments) OR OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);

DELETE app.OrderHistory WHERE OrderID_FK IN (SELECT Id FROM @Orders);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @Orders);

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED left=',
    (SELECT COUNT(*) FROM app.Orders WHERE Notes = N'e2e-qc998 order')
  + (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc998%')
  + (SELECT COUNT(*) FROM app.Tickets WHERE TicketNumber LIKE N'QC998-%'));
