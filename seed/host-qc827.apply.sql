-- QC-827: host-side data for the bill-rate cases (tests/39-bill-rates.spec.ts), in the host database (LOCAL_SQL_DATABASE):
--   * a throwaway vendor organisation 'E2E QC-827 Vendor' (role type Vendor) under the host organisation
--     (EnvironmentSetting HostOrganisationId), its app.VendorSettings row with DriversCanSeeBillRates = 0, and one truck
--     'E2E QC-827 Truck' (role type Truck),
--   * the Vendor-role user $(VendorUserId) ($(VendorEmail)) in that vendor, with the live EULA signed, and the driver
--     $(DriverUserId) ($(DriverEmail)) in that truck with the role Driver; both carry the Identity user's password hash, read from
--     [$(IdentityDb)] (same server), and UserUUID = their Identity sub, so assignments get a DriverUserUUID,
--   * a host admin $(AdminUserId) ($(AdminEmail)) with the host role Admin in the host organisation, for the Edit Vendor page
--     (the shared host admin has two-step verification whose key the tests do not have),
--   * a throwaway job (JobNotes 'e2e-qc827', per ton) copied from an existing job's customer, material, rate type and From
--     address, with its own To address 'E2E QC-827 Delivery' and one open-ended rate from 30 days ago whose Bill side differs
--     from its Invoice side (Invoice 95.25 / Bill 72.50, fuel applies: Fuel 4.40 % / Bill Fuel 3.30 %),
--   * one order on that job (Notes 'e2e-qc827') from yesterday to 14 days ahead (the host's day, TimeZoneSettings:TimeZoneId),
--   * the DeliverySite address type when app.List_AddressTypes has none (CreatedBy 'e2e-qc827'), because every job save
--     creates a DeliverySite address for the job's To side and fails without it.
-- Assignments are made by the tests through the host API. host-qc827.remove.sql deletes all of it; run it first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc827';
DECLARE @VendorUserId nvarchar(450) = N'$(VendorUserId)';
DECLARE @VendorEmail nvarchar(256) = N'$(VendorEmail)';
DECLARE @DriverUserId nvarchar(450) = N'$(DriverUserId)';
DECLARE @DriverEmail nvarchar(256) = N'$(DriverEmail)';
DECLARE @AdminUserId nvarchar(450) = N'$(AdminUserId)';
DECLARE @AdminEmail nvarchar(256) = N'$(AdminEmail)';
DECLARE @VendorName nvarchar(100) = N'E2E QC-827 Vendor';
DECLARE @TruckName nvarchar(100) = N'E2E QC-827 Truck';
DECLARE @DeliveryName nvarchar(100) = N'E2E QC-827 Delivery';

IF @VendorEmail NOT LIKE N'e2e.qc827.%@quarryconnect.test' OR @DriverEmail NOT LIKE N'e2e.qc827.%@quarryconnect.test'
   OR @AdminEmail NOT LIKE N'e2e.qc827.%@quarryconnect.test'
    THROW 50001, 'The throwaway emails must start with e2e.qc827. and end with @quarryconnect.test.', 1;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

DECLARE @VendorHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE Id = @VendorUserId AND NormalizedEmail = UPPER(@VendorEmail));
DECLARE @DriverHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE Id = @DriverUserId AND NormalizedEmail = UPPER(@DriverEmail));
DECLARE @AdminHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE Id = @AdminUserId AND NormalizedEmail = UPPER(@AdminEmail));
IF @VendorHash IS NULL OR @DriverHash IS NULL OR @AdminHash IS NULL
    THROW 50004, 'The throwaway Identity users do not exist; run identity-qc827-user.apply.sql first.', 1;

IF EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName = @VendorName) OR EXISTS (SELECT 1 FROM app.Jobs WHERE JobNotes = @Marker)
    THROW 50005, 'QC-827 data is already there; run host-qc827.remove.sql first.', 1;

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

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM app.List_AddressTypes WHERE AddressTypeName = N'DeliverySite')
    INSERT app.List_AddressTypes (Created, Updated, Active, CreatedBy, UpdatedBy, AddressTypeName)
    VALUES (GETUTCDATE(), GETUTCDATE(), 1, @Marker, @Marker, N'DeliverySite');

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc827'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, @VendorName, 'E2E827V', @VendorType;
DECLARE @VendorId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = @VendorName);
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, @TruckName, 'E2E827T', @TruckType;
DECLARE @TruckId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @VendorId AND OrganisationName = @TruckName);

INSERT app.VendorSettings (OrganisationID_FK, Created, Updated, Active, NeedsSync, QBOrganisationName, DriversCanSeeBillRates)
VALUES (@VendorId, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E827V', 0);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    @VendorUserId, CONVERT(uniqueidentifier, @VendorUserId), @VendorEmail, UPPER(@VendorEmail), @VendorEmail, UPPER(@VendorEmail), 1, @VendorHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-827 Vendor',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @VendorId, 0, 0, 1, 0, 0
),
(
    @DriverUserId, CONVERT(uniqueidentifier, @DriverUserId), @DriverEmail, UPPER(@DriverEmail), @DriverEmail, UPPER(@DriverEmail), 1, @DriverHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-827 Driver',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @TruckId, 0, 0, 1, 0, 0
),
(
    @AdminUserId, CONVERT(uniqueidentifier, @AdminUserId), @AdminEmail, UPPER(@AdminEmail), @AdminEmail, UPPER(@AdminEmail), 1, @AdminHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-827 Admin',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @HostOrganisationId,
    ISNULL((SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL), 0), 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@VendorUserId, N'Vendor'), (@DriverUserId, N'Driver'), (@AdminUserId, N'Admin');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate)
    VALUES (@VendorUserId, @EulaDocId, @EulaVersion, SYSDATETIME()), (@DriverUserId, @EulaDocId, @EulaVersion, SYSDATETIME()),
           (@AdminUserId, @EulaDocId, @EulaVersion, SYSDATETIME());

INSERT app.Addresses (Created, Updated, Active, AddressName, Address1, City, StateID_FK, ZIP)
VALUES (GETUTCDATE(), GETUTCDATE(), 1, @DeliveryName, N'827 Congress Ave', N'Austin', @ToStateId, N'78701');
DECLARE @ToAddressId int = SCOPE_IDENTITY();

INSERT app.Jobs
(
    Created, Updated, Active, RateTypeID_FK, UnitID_FK, MaterialID_FK, InvoiceMaterials, CustomerID_FK, CustomerPO, JobNotes, ProjectName,
    Taxable, SalesPersonUserID_FK, JobStatusID_FK, IsNightShift, JobUUID, FuelSurchargeBaseID_FK
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, RateTypeID_FK, 1, MaterialID_FK, 0, CustomerID_FK, N'E2E827', @Marker, N'E2E QC-827',
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
VALUES (GETUTCDATE(), GETUTCDATE(), 1, @JobId, DATEADD(DAY, -30, @Today), NULL, 95.25, 72.50, 1, 4.40, 6.15, 8.65, 0, 3.30);

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
