-- DFLOW: removes what tests/drivers/driver-flows.spec.ts left in DRIVERS_SQL_DATABASE: for the drivers in $(UserIds) (comma-separated
-- Identity UserUUIDs; pass none when there are none) their host links, assignments, trips, tickets, messages, commands, tombstones, device
-- tokens, signed EULAs, GPS points, DRIVERS auth.Users rows and roles; and the 'e2e-dflow' assignments of any driver with their trips,
-- tickets, messages and commands. Prints REMOVED links=<n>;leftLinks=<n>;leftAssignments=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Uuids TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Uuids SELECT DISTINCT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(UserIds)', N',')
WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;

DECLARE @AuthUsers TABLE (Id nvarchar(450) PRIMARY KEY);
IF OBJECT_ID(N'auth.Users', N'U') IS NOT NULL
    INSERT @AuthUsers SELECT Id FROM auth.Users WHERE UserUUID IN (SELECT Id FROM @Uuids);

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT DISTINCT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'e2e-dflow%' OR DriverUserUUID IN (SELECT Id FROM @Uuids);
DECLARE @Trips TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Trips SELECT DISTINCT TripUUID FROM app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR UserUUID IN (SELECT Id FROM @Uuids);
DECLARE @Tickets TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Tickets SELECT DISTINCT TicketUUID FROM app.Tickets
WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips) OR UserUUID IN (SELECT Id FROM @Uuids);

DECLARE @Links int = 0;

BEGIN TRANSACTION;

DELETE app.TripGps WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR TripUUID IN (SELECT Id FROM @Trips) OR DeviceID LIKE N'e2e-dflow%';
DELETE app.DriverCommands
WHERE TargetUUID IN (SELECT Id FROM @Assignments) OR TargetUUID IN (SELECT Id FROM @Trips) OR TargetUUID IN (SELECT Id FROM @Tickets) OR UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Tickets WHERE TicketUUID IN (SELECT Id FROM @Tickets);
DELETE app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR DriverUserUUID IN (SELECT Id FROM @Uuids);
DELETE app.Trips WHERE TripUUID IN (SELECT Id FROM @Trips);
DELETE app.SyncTombstones
WHERE EntityUUID IN (SELECT Id FROM @Assignments) OR EntityUUID IN (SELECT Id FROM @Trips) OR EntityUUID IN (SELECT Id FROM @Tickets) OR UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DeviceTokens WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverSignedEulas WHERE UserUUID IN (SELECT Id FROM @Uuids);
DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Uuids);
SET @Links = @@ROWCOUNT;
IF EXISTS (SELECT 1 FROM @AuthUsers)
BEGIN
    DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @AuthUsers);
    DELETE auth.Users WHERE Id IN (SELECT Id FROM @AuthUsers);
END

COMMIT TRANSACTION;

DECLARE @LeftLinks int = (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID IN (SELECT Id FROM @Uuids));
DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'e2e-dflow%' OR DriverUserUUID IN (SELECT Id FROM @Uuids));
PRINT CONCAT('REMOVED links=', @Links, ';leftLinks=', @LeftLinks, ';leftAssignments=', @LeftAssignments);
