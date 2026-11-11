-- QC-910: host-side data for the dispatch-contact cases (tests/app/dispatch-contact.spec.ts), in the host database (LOCAL_SQL_DATABASE):
--   * two throwaway vendors under the host organisation (EnvironmentSetting HostOrganisationId): 'E2E QC-910 Vendor A'
--     (short E2E910A) with truck 'E2E QC-910 Truck A' (number E2E910TA), and 'E2E QC-910 Vendor B' (E2E910B) with truck
--     'E2E QC-910 Truck B' (E2E910TB); each vendor gets an app.VendorSettings row with no dispatch contact, and Vendor A's
--     billing contact (BillToUserID_FK) is the alpha user, so the cases can prove it never changes,
--   * one host user per e2e.qc910.<name>@quarryconnect.test Identity user (read from [$(IdentityDb)], same server, with the
--     same Id, UserUUID and password hash): admin (Admin, host organisation), alpha (Vendor, Vendor A, phone 5125559101),
--     bravo (Vendor, Vendor A, no phone), driver (Driver, Truck A), mover (Driver, Truck B) and bee (Vendor, Vendor B),
--     all with the live EULA signed and the user name 'E2E' + ' QC-910 <Name>',
--   * a throwaway job (JobNotes 'e2e-qc910') copied from an existing job's customer, material, rate type and From address,
--     with its own To address 'E2E QC-910 Delivery', and one order on it (Notes 'e2e-qc910') from yesterday to 14 days ahead
--     (the host's day, TimeZoneSettings:TimeZoneId), for the Vendor-only assignment cases.
-- host-qc910.remove.sql deletes all of it, plus what the pages save for these organisations; run it first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc910';

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

IF EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-910 %') OR EXISTS (SELECT 1 FROM app.Jobs WHERE JobNotes = @Marker)
    THROW 50005, 'QC-910 data is already there; run host-qc910.remove.sql first.', 1;

DECLARE @People TABLE (Name nvarchar(20) PRIMARY KEY, Role nvarchar(20) NOT NULL, Org nvarchar(10) NOT NULL, Phone nvarchar(20) NULL, Id nvarchar(450) NULL, Email nvarchar(256) NULL, Hash nvarchar(max) NULL);
INSERT @People (Name, Role, Org, Phone) VALUES
    (N'admin', N'Admin', N'host', NULL),
    (N'alpha', N'Vendor', N'vendorA', N'5125559101'),
    (N'bravo', N'Vendor', N'vendorA', NULL),
    (N'driver', N'Driver', N'truckA', NULL),
    (N'mover', N'Driver', N'truckB', NULL),
    (N'bee', N'Vendor', N'vendorB', NULL);

UPDATE p SET Id = u.Id, Email = u.Email, Hash = u.PasswordHash
FROM @People p JOIN [$(IdentityDb)].auth.Users u ON u.NormalizedEmail = UPPER(N'e2e.qc910.' + p.Name + N'@quarryconnect.test');
IF EXISTS (SELECT 1 FROM @People WHERE Id IS NULL OR Hash IS NULL)
    THROW 50004, 'The throwaway Identity users do not exist; run identity-qc910-user.apply.sql for each first.', 1;

DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

DECLARE @TemplateJobId int, @TemplateFromAddressId int, @TemplateQuarryId int, @TemplateIsQuarry tinyint;
SELECT TOP 1 @TemplateJobId = j.JobID, @TemplateFromAddressId = ja.AddressID_FK, @TemplateQuarryId = ja.QuarryID_FK, @TemplateIsQuarry = ja.IsQuarry
FROM app.Jobs j
JOIN app.JobAddresses ja ON ja.JobID_FK = j.JobID AND ja.IsFrom = 1 AND ja.IsCurrent = 1 AND ja.Active = 1 AND ja.AddressID_FK > 0
WHERE j.Active = 1 AND j.CustomerID_FK > 0 AND j.MaterialID_FK > 0 AND ISNULL(j.JobNotes, N'') <> @Marker
ORDER BY j.JobID;
IF @TemplateJobId IS NULL
    THROW 50006, 'No job with a current From address to copy the customer, material and From address from.', 1;

DECLARE @TruckTypeId int, @DispatcherUserId nvarchar(450), @AreaId int;
SELECT TOP 1 @TruckTypeId = TruckTypeID_FK, @DispatcherUserId = DispatcherUserID_FK, @AreaId = AreaID_FK
FROM app.Orders WHERE Active = 1 AND TruckTypeID_FK IS NOT NULL ORDER BY OrderID DESC;

DECLARE @ToStateId int = (SELECT TOP 1 StateID FROM app.List_States WHERE StateAbbr = N'TX');
DECLARE @LocationId int = ISNULL((SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL), 0);

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc910'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-910 Vendor A', 'E2E910A', @VendorType;
DECLARE @VendorA int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-910 Vendor A');
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorA, N'E2E QC-910 Truck A', 'E2E910TA', @TruckType;
DECLARE @TruckA int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-910 Truck A');
EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-910 Vendor B', 'E2E910B', @VendorType;
DECLARE @VendorB int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-910 Vendor B');
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorB, N'E2E QC-910 Truck B', 'E2E910TB', @TruckType;
DECLARE @TruckB int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-910 Truck B');

INSERT app.VendorSettings (OrganisationID_FK, Created, Updated, Active, NeedsSync, QBOrganisationName, BillToUserId_Fk, DispatchContactUserID_FK)
VALUES (@VendorA, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E910A', (SELECT Id FROM @People WHERE Name = N'alpha'), NULL),
       (@VendorB, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E910B', NULL, NULL);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT p.Id, CONVERT(uniqueidentifier, p.Id), p.Email, UPPER(p.Email), p.Email, UPPER(p.Email), 1, p.Hash,
       UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
       p.Phone, 0, 0, 1, 0, N'E2E', N'QC-910 ' + UPPER(LEFT(p.Name, 1)) + SUBSTRING(p.Name, 2, 20),
       SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
       CASE p.Org WHEN N'host' THEN @HostOrganisationId WHEN N'vendorA' THEN @VendorA WHEN N'truckA' THEN @TruckA WHEN N'vendorB' THEN @VendorB ELSE @TruckB END,
       CASE p.Org WHEN N'host' THEN @LocationId ELSE 0 END, 0, 1, 0, 0
FROM @People p;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, Role FROM @People;

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate)
    SELECT Id, @EulaDocId, @EulaVersion, SYSDATETIME() FROM @People;

INSERT app.Addresses (Created, Updated, Active, AddressName, Address1, City, StateID_FK, ZIP)
VALUES (GETUTCDATE(), GETUTCDATE(), 1, N'E2E QC-910 Delivery', N'910 Congress Ave', N'Austin', @ToStateId, N'78701');
DECLARE @ToAddressId int = SCOPE_IDENTITY();

INSERT app.Jobs
(
    Created, Updated, Active, RateTypeID_FK, UnitID_FK, MaterialID_FK, InvoiceMaterials, CustomerID_FK, CustomerPO, JobNotes, ProjectName,
    Taxable, SalesPersonUserID_FK, JobStatusID_FK, IsNightShift, JobUUID, FuelSurchargeBaseID_FK
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, RateTypeID_FK, 1, MaterialID_FK, 0, CustomerID_FK, N'E2E910', @Marker, N'E2E QC-910',
       Taxable, SalesPersonUserID_FK, JobStatusID_FK, 0, NEWID(), FuelSurchargeBaseID_FK
FROM app.Jobs WHERE JobID = @TemplateJobId;
DECLARE @JobId int = SCOPE_IDENTITY();

INSERT app.JobAddresses (Created, Updated, Active, IsCurrent, IsFrom, IsTo, IsQuarry, JobID_FK, AddressID_FK, QuarryID_FK)
VALUES (GETUTCDATE(), GETUTCDATE(), 1, 1, 1, 0, @TemplateIsQuarry, @JobId, @TemplateFromAddressId, @TemplateQuarryId),
       (GETUTCDATE(), GETUTCDATE(), 1, 1, 0, 1, 0, @JobId, @ToAddressId, ISNULL(@TemplateQuarryId, 0));

INSERT app.JobRates
(
    Created, Updated, Active, JobID_FK, EffectiveFrom, EffectiveTo, InvoiceRate, BillRate, FuelApplies, FuelRate,
    MaterialCost, MaterialInvoiceRate, MaterialBillRate, BillFuelRate
)
VALUES (GETUTCDATE(), GETUTCDATE(), 1, @JobId, DATEADD(DAY, -30, @Today), NULL, 95.25, 72.50, 0, 0, 0, 0, 0, 0);

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK, OrderUUID
)
VALUES
(
    GETUTCDATE(), GETUTCDATE(), 1, @JobId, @DispatcherUserId, @AreaId, @TruckTypeId, 4,
    DATEADD(DAY, -1, @Today), DATEADD(DAY, 14, @Today), '06:00', '15:00', 4, 0, @Marker, 10, 2, NEWID()
);

COMMIT TRANSACTION;
