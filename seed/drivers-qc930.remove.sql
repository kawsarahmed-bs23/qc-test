-- QC-930: removes what drivers-qc930.apply.sql and the SMS routing cases (tests/app/sms-routing.spec.ts) left in
-- DRIVERS_SQL_DATABASE for the linked Driver $(UserId): the messages, trips, tickets, assignments, commands and tombstones the
-- host's JobOffered / MessageSent events made, the e2e-qc930 host link, the auth.Users row with its role, and the
-- 'E2E QC-930 Driver' organisation with its app.DriverSettings row.
-- Prints 'REMOVED left=<n>' (0 when clean).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');

DECLARE @AuthUsers TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @AuthUsers SELECT Id FROM auth.Users WHERE UserUUID = @UserUuid OR NormalizedEmail LIKE N'E2E.QC930.%@QUARRYCONNECT.TEST';

DECLARE @Organisations TABLE (Id int PRIMARY KEY);
INSERT @Organisations SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Driver';

BEGIN TRANSACTION;

DELETE app.Messages WHERE DriverUserUUID = @UserUuid OR OrderAssignmentUUID IN (SELECT OrderAssignmentUUID FROM app.OrderAssignments WHERE DriverUserUUID = @UserUuid);
DELETE app.Tickets WHERE UserUUID = @UserUuid;
DELETE app.Trips WHERE UserUUID = @UserUuid;
DELETE app.DriverCommands WHERE UserUUID = @UserUuid;
DELETE app.SyncTombstones WHERE UserUUID = @UserUuid;
DELETE app.OrderAssignments WHERE DriverUserUUID = @UserUuid;
DELETE app.DeviceTokens WHERE UserUUID = @UserUuid;
DELETE app.DriverHostLinks WHERE UserUUID = @UserUuid OR CreatedBy = N'e2e-qc930';
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @AuthUsers);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @AuthUsers);
DELETE app.DriverSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Organisations);

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED left=',
    (SELECT COUNT(*) FROM app.OrderAssignments WHERE DriverUserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM app.Messages WHERE DriverUserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM app.DriverHostLinks WHERE UserUUID = @UserUuid OR CreatedBy = N'e2e-qc930')
  + (SELECT COUNT(*) FROM auth.Users WHERE UserUUID = @UserUuid)
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Driver'));
