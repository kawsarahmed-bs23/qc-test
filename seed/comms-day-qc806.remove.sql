-- Removes everything comms-day-qc806.apply.sql added and everything the QC-806 tests wrote on top of it: the
-- order and assignments marked E2E-QC806, every message whose body carries the marker or that points at those
-- assignments, their history rows, trip notes and any driver-mirror change rows the triggers queued for them
-- (seen marks land on the seeded messages themselves). The seed changes no existing row, so nothing is put back.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC806';

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
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @Assignments) OR MessageID_FK IN (SELECT Id FROM @Messages);

COMMIT TRANSACTION;
