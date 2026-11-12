-- QC-922 (DRIVERS): removes what the host's JobOffered / JobCanceled events left in DRIVERS_SQL_DATABASE for the 'e2e-qc922'
-- assignments of tests/app/truck-number.spec.ts: the assignment rows, their trips, tickets, messages, commands and sync
-- tombstones. Hosts, links, users and DriverSettings stay.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc922%';

DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.TripGps', N'U') IS NOT NULL
    DELETE app.TripGps WHERE TripUUID IN (SELECT Id FROM @Trips) OR OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.Tickets WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);
DELETE app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones WHERE EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED left=', (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc922%'));
