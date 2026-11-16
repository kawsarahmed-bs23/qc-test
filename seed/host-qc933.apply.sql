-- QC-933: host-side data for the change proposal cases (tests/app/change-proposals.spec.ts, tests/drivers/change-proposals.spec.ts),
-- in the host database (LOCAL_SQL_DATABASE):
--   * a throwaway vendor 'E2E QC-933 Vendor' (short E2E933V) under the host organisation (EnvironmentSetting
--     HostOrganisationId) with an app.VendorSettings row, and two of its trucks: 'E2E QC-933 Truck A' (TruckSettings number
--     E2E933-A) and 'E2E QC-933 Truck B' (E2E933-B),
--   * host users e2e.qc933.<name>@quarryconnect.test (no Identity rows), all with the live EULA signed:
--       admin   (Admin, host organisation) and vendor (Vendor, the vendor): they sign in to the host API's own
--               api/account/login with the password of $(SourceEmail), whose PasswordHash is read from [$(IdentityDb)]
--               (same server, read only),
--       driver  (Driver, Truck A, phone 5125559331) with UserUUID $(DriverUuid), the Identity sub of the throwaway DRIVERS
--               driver, so the host treats it as linked, and an app.UserSettings row with NotifyBySms 0 and that phone,
--       driver2 (Driver, on the Vendor itself, so no Truck, phone 5125559332) with UserUUID $(DriverUuid2), another linked driver,
--       plain   (Driver, Truck B, phone 5125559333) with no UserUUID and no app.UserSettings row.
-- host-qc933.remove.sql deletes all of it. Run it first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc933';

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

IF EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-933 %')
   OR EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC933.%@QUARRYCONNECT.TEST')
    THROW 50005, 'QC-933 data is already there; run host-qc933.remove.sql first.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50004, 'The source test account does not exist in the Identity database or has no password.', 1;

DECLARE @People TABLE (Name nvarchar(20) PRIMARY KEY, Role nvarchar(20) NOT NULL, Org nvarchar(10) NOT NULL, Phone nvarchar(20) NULL,
    Linked bit NOT NULL, SignsIn bit NOT NULL, Id nvarchar(450) NOT NULL DEFAULT LOWER(CONVERT(nvarchar(36), NEWID())));
INSERT @People (Name, Role, Org, Phone, Linked, SignsIn) VALUES
    (N'admin', N'Admin', N'host', NULL, 0, 1),
    (N'vendor', N'Vendor', N'vendor', NULL, 0, 1),
    (N'driver', N'Driver', N'truckA', N'5125559331', 1, 0),
    (N'driver2', N'Driver', N'vendor', N'5125559332', 1, 0),
    (N'plain', N'Driver', N'truckB', N'5125559333', 0, 0);

DECLARE @LocationId int = ISNULL((SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL), 0);

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc933'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-933 Vendor', 'E2E933V', @VendorType;
DECLARE @Vendor int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-933 Vendor');
EXEC sp_executesql @OrgInsert, @OrgParams, @Vendor, N'E2E QC-933 Truck A', 'E2E933A', @TruckType;
DECLARE @TruckA int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-933 Truck A');
EXEC sp_executesql @OrgInsert, @OrgParams, @Vendor, N'E2E QC-933 Truck B', 'E2E933B', @TruckType;
DECLARE @TruckB int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-933 Truck B');

INSERT app.TruckSettings (OrganisationID_FK, Created, Updated, Active, TruckTypeID_FK, TruckNumber, VendorID_FK)
VALUES (@TruckA, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E933-A', @Vendor),
       (@TruckB, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E933-B', @Vendor);

INSERT app.VendorSettings (OrganisationID_FK, Created, Updated, Active, NeedsSync, QBOrganisationName, BillToUserId_Fk, DispatchContactUserID_FK)
VALUES (@Vendor, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E933V', NULL, NULL);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT p.Id, CASE p.Name WHEN N'driver' THEN CONVERT(uniqueidentifier, N'$(DriverUuid)') WHEN N'driver2' THEN CONVERT(uniqueidentifier, N'$(DriverUuid2)') WHEN N'plain' THEN NULL ELSE NEWID() END,
       N'e2e.qc933.' + p.Name + N'@quarryconnect.test', UPPER(N'e2e.qc933.' + p.Name + N'@quarryconnect.test'),
       N'e2e.qc933.' + p.Name + N'@quarryconnect.test', UPPER(N'e2e.qc933.' + p.Name + N'@quarryconnect.test'), 1,
       CASE WHEN p.SignsIn = 1 THEN @PasswordHash END,
       UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
       p.Phone, 0, 0, 1, 0, N'E2E', N'QC-933 ' + UPPER(LEFT(p.Name, 1)) + SUBSTRING(p.Name, 2, 20),
       SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
       CASE p.Org WHEN N'host' THEN @HostOrganisationId WHEN N'vendor' THEN @Vendor WHEN N'truckA' THEN @TruckA ELSE @TruckB END,
       CASE p.Org WHEN N'host' THEN @LocationId ELSE 0 END, 0, 1, 0, 0
FROM @People p;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, Role FROM @People;

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate)
    SELECT Id, @EulaDocId, @EulaVersion, SYSDATETIME() FROM @People;

INSERT app.UserSettings (UserID_FK, MobilePhone, NotifyBySms, NotifyByPush, Created, Updated, Active, CreatedBy, UpdatedBy)
SELECT Id, Phone, 0, 1, DATEADD(DAY, -1, GETUTCDATE()), DATEADD(DAY, -1, GETUTCDATE()), 1, @Marker, @Marker FROM @People WHERE Name IN (N'driver', N'driver2');

COMMIT TRANSACTION;
