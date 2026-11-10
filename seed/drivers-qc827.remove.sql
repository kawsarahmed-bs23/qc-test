-- QC-827: removes what drivers-qc827.apply.sql and the bill-rate cases (tests/39-bill-rates.spec.ts) left in
-- DRIVERS_SQL_DATABASE for the throwaway drivers in $(UserIds) (comma-separated Identity subs, or none): their assignment rate
-- rows (app.AssignmentRates), mirror assignments, trips, tickets, messages, commands, sync tombstones, device tokens and links.
-- Hosts and every other driver's rows stay.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Users SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(UserIds)', N',')
WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE DriverUserUUID IN (SELECT Id FROM @Users);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.AssignmentRates
WHERE DriverUserUUID IN (SELECT Id FROM @Users) AND OrderAssignmentUUID NOT IN (SELECT Id FROM @Assignments);

DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR UserUUID IN (SELECT Id FROM @Users);

BEGIN TRANSACTION;

DELETE app.AssignmentRates WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR DriverUserUUID IN (SELECT Id FROM @Users);
DELETE app.Tickets WHERE TripUUID IN (SELECT Id FROM @Trips) OR UserUUID IN (SELECT Id FROM @Users);
DELETE app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR DriverUserUUID IN (SELECT Id FROM @Users);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.DriverCommands WHERE UserUUID IN (SELECT Id FROM @Users) OR TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones WHERE UserUUID IN (SELECT Id FROM @Users) OR EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Users);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
