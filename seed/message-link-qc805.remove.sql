-- Removes everything message-link-qc805.apply.sql added and everything the QC-805 tests wrote on top of it: the
-- order and assignments marked E2E-QC805, every message whose body carries the marker or that points at those
-- assignments, their history rows (link, unlink, move, status changes), trip notes (Mark Late, No Show) and any
-- driver-mirror change rows the triggers queued for them. The seed changes no existing row, so nothing is put back.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC805';

BEGIN TRANSACTION;

DECLARE @Assignments TABLE (Id int PRIMARY KEY);
INSERT @Assignments
SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE Notes = @Marker OR OrderID_FK IN (SELECT OrderID FROM app.Orders WHERE Notes = @Marker);

DECLARE @Messages TABLE (Id int PRIMARY KEY);
INSERT @Messages
SELECT MessageID FROM app.Messages
WHERE MessageBody LIKE N'%' + @Marker + N'%' OR OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);

DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @Messages);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @Assignments);
DELETE app.Orders WHERE Notes = @Marker;
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR MessageID_FK IN (SELECT Id FROM @Messages);

COMMIT TRANSACTION;
