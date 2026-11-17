-- QC-983: host-side data for tests/app/users-list-refinements.spec.ts (USRL-*), in the host database:
--   * a throwaway vendor 'E2E QC-983 Vendor' with a truck 'E2E QC-983 Truck' under it, and a customer 'E2E QC-983 Customer',
--     all under the host organisation (EnvironmentSetting HostOrganisationId),
--   * six e2e.qc983.*@example.com users with no password and no Identity login, one per invite status and role case:
--       driver    Driver on the truck, no invite
--       vendor    Vendor of the vendor, linked (UserUUID set)
--       customer  Customer and Sales of the customer, invited (open invite)
--       expired   Sales, expired invite
--       declined  Accounting, declined invite
--       norole    no role, no invite
-- host-qc983.remove.sql removes all of it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
DECLARE @CustomerType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Customer');
IF @VendorType IS NULL OR @TruckType IS NULL OR @CustomerType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor, Truck or Customer row.', 1;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc983'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-983 Vendor', 'E2E983V', @VendorType;
DECLARE @VendorId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = N'E2E QC-983 Vendor');
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E QC-983 Truck', 'E2E983T', @TruckType;
DECLARE @TruckId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @VendorId AND OrganisationName = N'E2E QC-983 Truck');
EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-983 Customer', 'E2E983C', @CustomerType;
DECLARE @CustomerId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = N'E2E QC-983 Customer');

DECLARE @People TABLE (Name nvarchar(20), FirstName nvarchar(50), OrgId int, UserUuid uniqueidentifier NULL);
INSERT @People VALUES
    (N'driver', N'Drew', @TruckId, NULL),
    (N'vendor', N'Vera', @VendorId, NEWID()),
    (N'customer', N'Cass', @CustomerId, NULL),
    (N'expired', N'Eli', @HostOrganisationId, NULL),
    (N'declined', N'Dee', @HostOrganisationId, NULL),
    (N'norole', N'Nora', @HostOrganisationId, NULL);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest, SecurityStamp, ConcurrencyStamp
)
SELECT
    CONVERT(nvarchar(36), NEWID()), UserUuid, CONCAT(N'e2e.qc983.', Name, N'@example.com'), UPPER(CONCAT(N'e2e.qc983.', Name, N'@example.com')),
    CONCAT(N'e2e.qc983.', Name, N'@example.com'), UPPER(CONCAT(N'e2e.qc983.', Name, N'@example.com')), 1, 0,
    0, 1, 0, FirstName, N'QC-983', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, OrgId, 0, 1, 0, UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
FROM @People;

INSERT auth.UserToRoles (UserId, RoleName)
SELECT u.Id, r.RoleName
FROM auth.Users u
JOIN (VALUES
    (N'e2e.qc983.driver@example.com', N'Driver'),
    (N'e2e.qc983.vendor@example.com', N'Vendor'),
    (N'e2e.qc983.customer@example.com', N'Customer'),
    (N'e2e.qc983.customer@example.com', N'Sales'),
    (N'e2e.qc983.expired@example.com', N'Sales'),
    (N'e2e.qc983.declined@example.com', N'Accounting')
) AS r (Email, RoleName) ON u.NormalizedEmail = UPPER(r.Email);

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
EXEC(N'
INSERT app.UserInvites (UserInviteUUID, UserID_FK, InvitedEmail, UserType, Status, ExpiresAt, RespondedAt, CreatedBy, UpdatedBy)
SELECT NEWID(), u.Id, u.Email, i.UserType, i.Status, i.ExpiresAt, i.RespondedAt, N''e2e-qc983'', N''e2e-qc983''
FROM auth.Users u
JOIN (VALUES
    (N''e2e.qc983.customer@example.com'', N''customer'', 10, DATEADD(hour, 20, GETUTCDATE()), CONVERT(datetime, NULL)),
    (N''e2e.qc983.expired@example.com'', N''host'', 10, DATEADD(hour, -2, GETUTCDATE()), CONVERT(datetime, NULL)),
    (N''e2e.qc983.declined@example.com'', N''host'', 30, DATEADD(hour, 20, GETUTCDATE()), GETUTCDATE())
) AS i (Email, UserType, Status, ExpiresAt, RespondedAt) ON u.NormalizedEmail = UPPER(i.Email);
');

COMMIT TRANSACTION;

PRINT CONCAT('SEEDED vendor=', @VendorId, ';truck=', @TruckId, ';customer=', @CustomerId);
