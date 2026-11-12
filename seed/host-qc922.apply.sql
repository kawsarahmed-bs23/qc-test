-- QC-922: host-side data for the truck-number cases (tests/app/truck-number.spec.ts), in the host database (LOCAL_SQL_DATABASE):
--   * two throwaway vendors under the host organisation (EnvironmentSetting HostOrganisationId): 'E2E QC-922 Vendor A'
--     (short E2E922A) and 'E2E QC-922 Vendor B' (E2E922B), each with an app.VendorSettings row,
--   * one truck 'E2E QC-922 Seed Truck' under Vendor A whose OrganisationShortName (E2E922SH) differs from its
--     app.TruckSettings.TruckNumber (E2E922-SEED, VendorID_FK Vendor A), so a reader that still uses the short name shows,
--   * two host-only users (not in Identity; they sign in through the host API's own api/account/login with the password of
--     $(SourceEmail), whose host PasswordHash is copied): e2e.qc922.vendor@quarryconnect.test (Vendor, Vendor A) and
--     e2e.qc922.driver@quarryconnect.test (Driver, the Seed Truck), both with the live EULA signed.
--   * when auth.Organisations still has the legacy IsInvestmentFirm column as NOT NULL with no default (the QC-899 migration
--     that drops it is held), a temporary default DF_E2E_QC922_IsInvestmentFirm (0): the host API no longer maps that column,
--     so without it every Truck create through the API fails with "Cannot insert the value NULL into column
--     'IsInvestmentFirm'" before QC-922's code runs. host-qc922.remove.sql drops it again.
-- host-qc922.remove.sql deletes all of it, plus the trucks and assignments the cases make; run it first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF EXISTS (SELECT 1 FROM sys.columns WHERE object_id = OBJECT_ID(N'auth.Organisations') AND name = N'IsInvestmentFirm' AND is_nullable = 0 AND default_object_id = 0)
    ALTER TABLE auth.Organisations ADD CONSTRAINT DF_E2E_QC922_IsInvestmentFirm DEFAULT (0) FOR IsInvestmentFirm;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

IF COL_LENGTH(N'app.TruckSettings', N'TruckNumber') IS NULL
    THROW 50004, 'The QC-922 migration (app.TruckSettings.TruckNumber) is not applied.', 1;

IF EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-922 %')
    OR EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC922.%@QUARRYCONNECT.TEST')
    THROW 50005, 'QC-922 data is already there; run host-qc922.remove.sql first.', 1;

DECLARE @Hash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @Hash IS NULL
    THROW 50006, 'The source host account does not exist in the host database or has no password.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc922'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-922 Vendor A', 'E2E922A', @VendorType;
DECLARE @VendorA int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-922 Vendor A');
EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-922 Vendor B', 'E2E922B', @VendorType;
DECLARE @VendorB int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-922 Vendor B');
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorA, N'E2E QC-922 Seed Truck', 'E2E922SH', @TruckType;
DECLARE @SeedTruck int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-922 Seed Truck');

INSERT app.VendorSettings (OrganisationID_FK, Created, Updated, Active, NeedsSync, QBOrganisationName)
VALUES (@VendorA, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E922A'),
       (@VendorB, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E922B');

INSERT app.TruckSettings (OrganisationID_FK, Created, Updated, Active, TruckTypeID_FK, TruckNumber, VendorID_FK)
VALUES (@SeedTruck, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E922-SEED', @VendorA);

DECLARE @People TABLE (Name nvarchar(20) PRIMARY KEY, Role nvarchar(20) NOT NULL, Org int NOT NULL, Id nvarchar(450) NOT NULL, Email nvarchar(256) NOT NULL);
INSERT @People (Name, Role, Org, Id, Email) VALUES
    (N'vendor', N'Vendor', @VendorA, LOWER(CONVERT(nvarchar(36), NEWID())), N'e2e.qc922.vendor@quarryconnect.test'),
    (N'driver', N'Driver', @SeedTruck, LOWER(CONVERT(nvarchar(36), NEWID())), N'e2e.qc922.driver@quarryconnect.test');

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT p.Id, CONVERT(uniqueidentifier, p.Id), p.Email, UPPER(p.Email), p.Email, UPPER(p.Email), 1, @Hash,
       UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
       NULL, 0, 0, 1, 0, N'E2E', N'QC-922 ' + UPPER(LEFT(p.Name, 1)) + SUBSTRING(p.Name, 2, 20),
       SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), p.Org, 0, 0, 1, 0, 0
FROM @People p;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, Role FROM @People;

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate)
    SELECT Id, @EulaDocId, @EulaVersion, SYSDATETIME() FROM @People;

COMMIT TRANSACTION;

SELECT CONCAT('SEEDED vendorA=', @VendorA, ';vendorB=', @VendorB, ';seedTruck=', @SeedTruck);
