-- QC-937: removes what drivers-qc937.apply.sql and the reply confirmation cases left in DRIVERS_SQL_DATABASE: the 'E2E-QC937-RC <slot>'
-- assignments with every message in their threads and the driver commands for them, the driver's commands, tombstones and
-- device tokens, the e2e-qc937 driver-host link, and the 'E2E QC-937 Driver' user, role, settings and organisation.
-- $(UserId) is the linked driver's UUID. Prints 'REMOVED left=<n>', the rows still there afterwards (must be 0).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC937-RC %' OR DriverUserUUID = @UserUuid;

DECLARE @Messages TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Messages SELECT MessageUUID FROM app.Messages
WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments) OR DriverUserUUID = @UserUuid OR MessageBody LIKE N'%E2E-QC937-RC %';

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, OrganisationId int);
INSERT @Users SELECT Id, OrganisationIdFk FROM auth.Users WHERE UserUUID = @UserUuid OR NormalizedEmail = N'E2E.QC937.LINKED@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE app.DriverCommands WHERE UserUUID = @UserUuid OR TargetUUID IN (SELECT Id FROM @Messages) OR TargetUUID IN (SELECT Id FROM @Assignments);
DELETE app.Messages WHERE MessageUUID IN (SELECT Id FROM @Messages);
DELETE app.Trips WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.SyncTombstones WHERE UserUUID = @UserUuid;
DELETE app.DeviceTokens WHERE UserUUID = @UserUuid;
DELETE app.DriverHostLinks WHERE UserUUID = @UserUuid OR CreatedBy = N'e2e-qc937';
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE app.DriverSettings WHERE OrganisationID_FK IN (SELECT OrganisationId FROM @Users) OR CreatedBy = N'e2e-qc937';
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);
DELETE auth.Organisations WHERE OrganisationName = N'E2E QC-937 Driver';

COMMIT TRANSACTION;

SELECT CONCAT(N'REMOVED left=',
    (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC937-RC %' OR DriverUserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM app.Messages WHERE DriverUserUUID = @UserUuid OR MessageBody LIKE N'%E2E-QC937-RC %')
  + (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM auth.Users WHERE UserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-937 Driver'));
