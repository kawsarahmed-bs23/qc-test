-- QC-873 (DRIVERS): removes what tests/drivers/ticket-submit.spec.ts left in DRIVERS_SQL_DATABASE: the 'e2e-qc873'
-- assignments the host's JobOffered made, their trips, tickets (with the review-ticket commands that target the
-- TicketUUID), messages, commands, sync tombstones, and every app.TripGps point the spec sent (DeviceID 'e2e-qc873%',
-- including the untagged and unknown-trip points that name no assignment). Hosts, links, users and settings stay.
-- The ticket photos the spec uploaded stay in the Drivers S3 bucket (drivers/tickets/<host>/<user>/<ticket>.jpg).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc873%';

DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Tickets SELECT DISTINCT TicketUUID FROM app.Tickets
WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);

BEGIN TRANSACTION;

DELETE app.TripGps
WHERE DeviceID LIKE N'e2e-qc873%' OR OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);
DELETE app.DriverCommands
WHERE TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips) OR TargetUUID IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE TicketUUID IN (SELECT Id FROM @Tickets);
DELETE app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones
WHERE EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips) OR EntityUUID IN (SELECT Id FROM @Tickets);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

COMMIT TRANSACTION;
