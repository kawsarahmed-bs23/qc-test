-- QC-898: host-only data for the host UUID cases (tests/33-host-uuids.spec.ts), in the host database:
--   * a throwaway vendor organisation 'E2E QC-898 Vendor' (role type Vendor) under the host organisation
--     (EnvironmentSetting HostOrganisationId) with two trucks 'E2E QC-898 Truck 1' and 'E2E QC-898 Truck 2' (role type Truck);
--     their OrganisationUUIDs come from the column default,
--   * e2e.qc898.dispatcher (host role Admin, host organisation) and e2e.qc898.vendor (host role Vendor, the vendor
--     organisation), both signing in to the host API's own api/account/login with the password of $(SourceEmail): its
--     PasswordHash is read from [$(IdentityDb)] (same server, read only),
--   * e2e.qc898.driver1 (role Driver, Truck 1, UserUUID = Id) and e2e.qc898.driver2 (role Driver, Truck 2, UserUUID NULL),
--   * one order with Notes 'e2e-qc898' from today (the host's TimeZoneSettings:TimeZoneId) to today + 3; job, truck type and
--     dispatcher are copied from the newest active order that is not an e2e one (read only). Assignments are made by the tests.
-- Nothing is written to Identity or DRIVERS. Re-running replaces everything; host-qc898.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc898';
DECLARE @VendorName nvarchar(200) = N'E2E QC-898 Vendor';

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50001, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50002, 'auth.RoleTypes has no Vendor or Truck row.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50003, 'The source test account does not exist in Identity or has no password.', 1;

IF EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC898.%@QUARRYCONNECT.TEST')
    OR EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName = @VendorName)
    THROW 50004, 'QC-898 rows are still in the host database; run host-qc898.remove.sql first.', 1;

DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

DECLARE @JobId int, @TruckTypeId int, @DispatcherUserId nvarchar(450);
SELECT TOP 1 @JobId = JobID_FK, @TruckTypeId = TruckTypeID_FK, @DispatcherUserId = DispatcherUserID_FK
FROM app.Orders WHERE Active = 1 AND ISNULL(Notes, N'') NOT LIKE N'e2e-%' ORDER BY OrderID DESC;
IF @JobId IS NULL
    THROW 50005, 'No active order to copy the job, truck type and dispatcher from.', 1;

DECLARE @HostLocationId int = (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL);

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc898'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, @VendorName, 'E2E898V', @VendorType;
DECLARE @VendorId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = @VendorName);

EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E QC-898 Truck 1', 'E2E898T1', @TruckType;
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E QC-898 Truck 2', 'E2E898T2', @TruckType;
DECLARE @Truck1 int = (SELECT OrganisationID FROM auth.Organisations WHERE ParentOrganisationIdFk = @VendorId AND OrganisationName = N'E2E QC-898 Truck 1');
DECLARE @Truck2 int = (SELECT OrganisationID FROM auth.Organisations WHERE ParentOrganisationIdFk = @VendorId AND OrganisationName = N'E2E QC-898 Truck 2');

DECLARE @Users TABLE (Email nvarchar(256) PRIMARY KEY, Id nvarchar(450), UserUuid uniqueidentifier NULL, LastName nvarchar(100), RoleName nvarchar(50),
    OrganisationId int, LocationId int, HasPassword bit);
DECLARE @Driver1 nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT @Users VALUES
    (N'e2e.qc898.dispatcher@quarryconnect.test', LOWER(CONVERT(nvarchar(36), NEWID())), NULL, N'QC-898 Dispatcher', N'Admin', @HostOrganisationId, @HostLocationId, 1),
    (N'e2e.qc898.vendor@quarryconnect.test', LOWER(CONVERT(nvarchar(36), NEWID())), NULL, N'QC-898 Vendor', N'Vendor', @VendorId, 0, 1),
    (N'e2e.qc898.driver1@quarryconnect.test', @Driver1, CONVERT(uniqueidentifier, @Driver1), N'QC-898 Driver 1', N'Driver', @Truck1, 0, 0),
    (N'e2e.qc898.driver2@quarryconnect.test', LOWER(CONVERT(nvarchar(36), NEWID())), NULL, N'QC-898 Driver 2', N'Driver', @Truck2, 0, 0);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT
    u.Id, u.UserUuid, u.Email, UPPER(u.Email), u.Email, UPPER(u.Email), 1, CASE WHEN u.HasPassword = 1 THEN @PasswordHash END,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', u.LastName,
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), u.OrganisationId, u.LocationId, 0, 1, 0, 0
FROM @Users u;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, RoleName FROM @Users;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;
IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) SELECT Id, @EulaDocId, @EulaVersion, SYSDATETIME() FROM @Users WHERE HasPassword = 1;

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK
)
VALUES
(
    GETUTCDATE(), GETUTCDATE(), 1, @JobId, @DispatcherUserId, NULL, @TruckTypeId, 4,
    @Today, DATEADD(DAY, 3, @Today), '00:00', '23:59', 4, 0, @Marker, 10, 2
);

COMMIT TRANSACTION;
