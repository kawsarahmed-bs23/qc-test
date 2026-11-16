-- QC-933: in DRIVERS_SQL_DATABASE (QC-902 one list), gives the throwaway driver $(UserId) (the Identity sub of
-- $(Email)) a Driver account the way a Host invite acceptance would, and links it to the host $(HostUuid):
--   * an auth.Organisations row of the Driver role type ('E2E QC-933 Driver <Name>'), an auth.Users row (UserUUID = the
--     sub, the phone $(Phone)), the Driver role in auth.UserToRoles and an app.DriverSettings row with TruckNumber $(TruckNumber)
--     (empty when it is the word NONE),
--   * an active app.DriverHostLinks row to the host, marked synced so the resync sweep leaves it alone,
--   * when $(SecondHost) is 1, a throwaway second host 'E2E QC-933 Second Host' (CreatedBy e2e, message endpoint
--     tcp://localhost:6299 that nothing listens on) and a link to it, for the fan-out case.
-- drivers-qc933.remove.sql deletes all of it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverSettings', N'U') IS NULL OR OBJECT_ID(N'auth.Organisations', N'U') IS NULL OR COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 migrations.', 1;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');
DECLARE @HostUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(HostUuid)');
DECLARE @Name nvarchar(50) = N'$(Name)';
DECLARE @TruckNumber nvarchar(50) = CASE WHEN N'$(TruckNumber)' = N'NONE' THEN NULL ELSE N'$(TruckNumber)' END;
DECLARE @RoleTypeId varchar(100) = UPPER(CONVERT(varchar(36), (SELECT RoleTypeId FROM auth.RoleTypes WHERE RoleType = N'Driver')));
DECLARE @RoleId nvarchar(450) = (SELECT Id FROM auth.Roles WHERE NormalizedName = N'DRIVER');
IF @RoleTypeId IS NULL OR @RoleId IS NULL
    THROW 50002, 'The Driver role type or role is missing.', 1;
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50004, 'The host is not an active host in DRIVERS.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE UserUUID = @UserUuid)
    THROW 50003, 'The driver already has a Driver account; run drivers-qc933.remove.sql first.', 1;

BEGIN TRANSACTION;

INSERT auth.Organisations (OrganisationName, OrganisationShortName, CountryClassIdFk, RoleTypeIdFk, UpdatedOn, UpdatedBy, IsActive)
VALUES (N'E2E QC-933 Driver ' + @Name, 'EQ933', 0, @RoleTypeId, GETUTCDATE(), 'e2e', 1);
DECLARE @OrganisationId int = SCOPE_IDENTITY();

DECLARE @Id nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT auth.Users (Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, FirstName, LastName, PhoneNumber, OrganisationIdFk, CreateDate, IsActive)
VALUES (@Id, @UserUuid, N'$(Email)', UPPER(N'$(Email)'), N'$(Email)', UPPER(N'$(Email)'), N'E2E', N'QC-933 ' + @Name, N'$(Phone)', @OrganisationId, SYSDATETIMEOFFSET(), 1);

INSERT auth.UserToRoles (UserId, RoleId) VALUES (@Id, @RoleId);

INSERT app.DriverSettings (OrganisationID_FK, TruckNumber, CreatedBy, UpdatedBy) VALUES (@OrganisationId, @TruckNumber, N'e2e', N'e2e');

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
VALUES (@UserUuid, @HostUuid, N'e2e', N'e2e', GETUTCDATE(), GETUTCDATE(), N'E2E QC-933 ' + @Name);

IF N'$(SecondHost)' = N'1'
BEGIN
    DECLARE @SecondHost uniqueidentifier = (SELECT HostUUID FROM app.Hosts WHERE HostName = N'E2E QC-933 Second Host' AND CreatedBy = N'e2e');
    IF @SecondHost IS NULL
    BEGIN
        SET @SecondHost = NEWID();
        INSERT app.Hosts (HostUUID, HostName, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
        VALUES (@SecondHost, N'E2E QC-933 Second Host', GETUTCDATE(), GETUTCDATE(), 1, N'e2e', N'e2e', N'tcp://localhost:6299', 1, N'Central Standard Time');
    END

    INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
    VALUES (@UserUuid, @SecondHost, N'e2e', N'e2e', GETUTCDATE(), GETUTCDATE(), N'E2E QC-933 ' + @Name);
END

COMMIT TRANSACTION;
