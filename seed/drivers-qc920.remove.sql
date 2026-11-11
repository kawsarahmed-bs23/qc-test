-- QC-920 (DRIVERS): removes what the host's JobOffered / JobChanged / MessageSent / LocationRequested events and the
-- driver's own writes left in DRIVERS_SQL_DATABASE for the 'e2e-qc920' assignments of tests/36-driver-events.spec.ts:
-- the assignment rows, their trips, tickets, messages, commands and sync tombstones, and (since QC-873) the app.TripGps
-- points stored for those trips and assignments. Hosts, links and users stay.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc920%';

DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Tickets SELECT DISTINCT TicketUUID FROM app.Tickets WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.TripGps', N'U') IS NOT NULL
    DELETE app.TripGps WHERE TripUUID IN (SELECT Id FROM @Trips) OR OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);
DELETE app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones WHERE EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

COMMIT TRANSACTION;
