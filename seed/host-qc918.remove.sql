-- QC-918 (host API): removes what tests/drivers/push-notifications.spec.ts made on the host through the API: the 'e2e-qc918'
-- assignments (and any assignment a reassignment linked to them), their trips, GPS points, notes, history and schedule
-- snapshots, and every message on them or whose body starts with 'e2e-qc918' (this host build links a dispatch message to
-- the driver's first thread, whatever assignment was named). Orders, jobs, trucks and users are only read and stay.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc918%';
INSERT @Assignments SELECT a.OrderAssignmentID FROM app.OrderAssignments a
WHERE (a.OriginalAssignmentID_FK IN (SELECT Id FROM @Assignments) OR a.ReassignedToAssignmentID_FK IN (SELECT Id FROM @Assignments))
  AND a.OrderAssignmentID NOT IN (SELECT Id FROM @Assignments);

DECLARE @Trips TABLE (Id int PRIMARY KEY);
INSERT @Trips SELECT TripID FROM app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id int PRIMARY KEY);
INSERT @Tickets SELECT TicketID FROM app.Tickets WHERE TripID_FK IN (SELECT Id FROM @Trips);

DECLARE @Batches TABLE (Id int PRIMARY KEY);
INSERT @Batches SELECT DISTINCT TicketBatchID_FK FROM app.Tickets WHERE TicketID IN (SELECT Id FROM @Tickets) AND TicketBatchID_FK > 0;

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages SELECT MessageID FROM app.Messages WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR MessageBody LIKE N'e2e-qc918%';

BEGIN TRANSACTION;

DELETE app.TripGps WHERE TripID_FK IN (SELECT Id FROM @Trips) OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
UPDATE app.Trips SET TicketID_FK = NULL WHERE TripID IN (SELECT Id FROM @Trips) AND TicketID_FK IS NOT NULL;
IF OBJECT_ID(N'app.TicketFlags', N'U') IS NOT NULL
    DELETE app.TicketFlags WHERE TicketID_FK IN (SELECT Id FROM @Tickets);
DELETE app.TicketHistory WHERE TicketID_FK IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE TicketID IN (SELECT Id FROM @Tickets);
DELETE app.TicketBatches
WHERE TicketBatchID IN (SELECT Id FROM @Batches) AND NOT EXISTS (SELECT 1 FROM app.Tickets t WHERE t.TicketBatchID_FK = app.TicketBatches.TicketBatchID);

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

COMMIT TRANSACTION;
