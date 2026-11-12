-- QC-918 (DRIVERS): removes what tests/drivers/push-notifications.spec.ts left in DRIVERS_SQL_DATABASE: the rows the host's
-- JobOffered / JobChanged / MessageSent events made for the 'e2e-qc918' assignments (with their trips, tickets, messages,
-- commands and sync tombstones), dispatch messages whose body starts with 'e2e-qc918', and the device tokens the spec
-- registered (ExponentPushToken[e2e-qc918...]) or that manual QC-918 checks left (ExponentPushToken[qc918-...]).
-- Hosts, links and users stay.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-qc918%';

DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);

DECLARE @Tickets TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Tickets SELECT DISTINCT TicketUUID FROM app.Tickets WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);

DECLARE @Messages TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Messages SELECT DISTINCT MessageUUID FROM app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR MessageBody LIKE N'e2e-qc918%';

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.TripGps', N'U') IS NOT NULL
    DELETE app.TripGps WHERE TripUUID IN (SELECT Id FROM @Trips) OR OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Tickets);
DELETE app.Tickets WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips);
UPDATE app.Messages SET ReplyToMessageUUID = NULL WHERE ReplyToMessageUUID IN (SELECT Id FROM @Messages);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Messages);
DELETE app.SyncTombstones WHERE EntityUUID IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageUUID IN (SELECT Id FROM @Messages);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones WHERE EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DeviceTokens WHERE Token LIKE N'ExponentPushToken\[e2e-qc918%' ESCAPE N'\' OR Token LIKE N'ExponentPushToken\[qc918-%' ESCAPE N'\';

COMMIT TRANSACTION;
