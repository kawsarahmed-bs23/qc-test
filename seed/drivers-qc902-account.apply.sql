-- QC-902: in DRIVERS_SQL_DATABASE, gives the throwaway driver $(UserId) (the Identity sub) a Driver account the way a
-- Host invite acceptance would: an auth.Organisations row of the Driver role type ('E2E QC-902 Driver'), an auth.Users row
-- (Id a new GUID string, UserUUID = the sub), the Driver role in auth.UserToRoles and an empty app.DriverSettings row.
-- drivers-qc902.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverSettings', N'U') IS NULL OR OBJECT_ID(N'auth.Organisations', N'U') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 migrations (022-026).', 1;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');
DECLARE @RoleTypeId varchar(100) = UPPER(CONVERT(varchar(36), (SELECT RoleTypeId FROM auth.RoleTypes WHERE RoleType = N'Driver')));
DECLARE @RoleId nvarchar(450) = (SELECT Id FROM auth.Roles WHERE NormalizedName = N'DRIVER');
IF @RoleTypeId IS NULL OR @RoleId IS NULL
    THROW 50002, 'The Driver role type or role is missing (DRIVERS migration 023).', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE UserUUID = @UserUuid)
    THROW 50003, 'The driver already has a Driver account; run drivers-qc902.remove.sql first.', 1;

BEGIN TRANSACTION;

INSERT auth.Organisations (OrganisationName, OrganisationShortName, CountryClassIdFk, RoleTypeIdFk, UpdatedOn, UpdatedBy, IsActive)
VALUES (N'E2E QC-902 Driver', 'EQD', 0, @RoleTypeId, GETUTCDATE(), 'e2e', 1);
DECLARE @OrganisationId int = SCOPE_IDENTITY();

DECLARE @Id nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT auth.Users (Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, FirstName, LastName, OrganisationIdFk, CreateDate, IsActive)
VALUES (@Id, @UserUuid, N'$(Email)', UPPER(N'$(Email)'), N'$(Email)', UPPER(N'$(Email)'), N'E2E', N'QC-902 Driver', @OrganisationId, SYSDATETIMEOFFSET(), 1);

INSERT auth.UserToRoles (UserId, RoleId) VALUES (@Id, @RoleId);

INSERT app.DriverSettings (OrganisationID_FK, TruckNumber, CreatedBy, UpdatedBy) VALUES (@OrganisationId, NULL, N'e2e', N'e2e');

COMMIT TRANSACTION;
