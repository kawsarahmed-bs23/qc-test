-- QC-930: the DRIVERS side of the linked Driver in tests/app/sms-routing.spec.ts (DRIVERS_SQL_DATABASE), the way a Host invite
-- acceptance would leave it: an auth.Organisations row of the Driver role type ('E2E QC-930 Driver'), an auth.Users row (Id a
-- new GUID string, UserUUID $(UserId), email e2e.qc930.linked@quarryconnect.test, phone 5125559301), the Driver role, an
-- app.DriverSettings row with NotifyBySms 1 and ContactVersion NULL, and an active app.DriverHostLinks row to $(HostUuid)
-- (CreatedBy 'e2e-qc930', SmsOptedOut 0, marked as synced so the resync sweep leaves it alone).
-- drivers-qc930.remove.sql deletes it with every assignment and message the host's events made for that driver.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH(N'app.DriverSettings', N'NotifyBySms') IS NULL OR COL_LENGTH(N'app.DriverSettings', N'ContactVersion') IS NULL
    THROW 50001, 'The QC-930 DRIVERS migration (app.DriverSettings.NotifyBySms / ContactVersion) is not applied.', 1;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');
DECLARE @HostUuid uniqueidentifier = (SELECT HostUUID FROM app.Hosts WHERE HostUUID = CONVERT(uniqueidentifier, N'$(HostUuid)') AND Active = 1);
IF @HostUuid IS NULL
    THROW 50002, 'The host is not an active host in the drivers database.', 1;

DECLARE @RoleTypeId varchar(100) = UPPER(CONVERT(varchar(36), (SELECT RoleTypeId FROM auth.RoleTypes WHERE RoleType = N'Driver')));
DECLARE @RoleId nvarchar(450) = (SELECT Id FROM auth.Roles WHERE NormalizedName = N'DRIVER');
IF @RoleTypeId IS NULL OR @RoleId IS NULL
    THROW 50003, 'The Driver role type or role is missing.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE UserUUID = @UserUuid) OR EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Driver')
    THROW 50004, 'The QC-930 driver is already there; run drivers-qc930.remove.sql first.', 1;

BEGIN TRANSACTION;

INSERT auth.Organisations (OrganisationName, OrganisationShortName, CountryClassIdFk, RoleTypeIdFk, UpdatedOn, UpdatedBy, IsActive)
VALUES (N'E2E QC-930 Driver', 'E930', 0, @RoleTypeId, GETUTCDATE(), 'e2e-qc930', 1);
DECLARE @OrganisationId int = SCOPE_IDENTITY();

DECLARE @Id nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT auth.Users (Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, FirstName, LastName, PhoneNumber, OrganisationIdFk, CreateDate, IsActive)
VALUES (@Id, @UserUuid, N'e2e.qc930.linked@quarryconnect.test', N'E2E.QC930.LINKED@QUARRYCONNECT.TEST', N'e2e.qc930.linked@quarryconnect.test',
        N'E2E.QC930.LINKED@QUARRYCONNECT.TEST', N'E2E', N'QC-930 Linked', N'5125559301', @OrganisationId, SYSDATETIMEOFFSET(), 1);

INSERT auth.UserToRoles (UserId, RoleId) VALUES (@Id, @RoleId);

INSERT app.DriverSettings (OrganisationID_FK, TruckNumber, NotifyBySms, ContactVersion, CreatedBy, UpdatedBy)
VALUES (@OrganisationId, NULL, 1, NULL, N'e2e-qc930', N'e2e-qc930');

INSERT app.DriverHostLinks (UserUUID, HostUUID, DriverName, SyncRequestedAt, SyncedAt, CreatedBy, UpdatedBy)
VALUES (@UserUuid, @HostUuid, N'E2E QC-930 Linked', GETUTCDATE(), GETUTCDATE(), N'e2e-qc930', N'e2e-qc930');

COMMIT TRANSACTION;

SELECT CONCAT('SEEDED drivers user=', @Id);
