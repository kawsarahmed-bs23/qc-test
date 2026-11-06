-- QC-774: host-side data for the driver-invite cases (tests/30-driver-invites.spec.ts), in the host database:
--   * a throwaway vendor organisation 'E2E QC-774 Vendor' (role type Vendor) under the host organisation
--     (EnvironmentSetting HostOrganisationId), with two trucks 'E2E QC-774 Truck 1' and 'E2E QC-774 Truck 2' (role type Truck),
--   * the vendor user $(UserId) ($(Email)) in that organisation with the host role Vendor, the live EULA signed and the
--     password hash of the Identity user with the same Id, read from [$(IdentityDb)] (same server), so both the host's own
--     api/account/login and the Identity sign-in of the host app work.
-- Invites are sent by the tests; the driver users the invite flow creates (Id = the driver's Identity sub) and every invite
-- of the vendor are removed by host-qc774.remove.sql, which this script also runs first in effect (re-running replaces everything).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @VendorName nvarchar(200) = N'E2E QC-774 Vendor';

IF @Email NOT LIKE N'e2e.qc774.%@quarryconnect.test'
    THROW 50001, 'The vendor email must start with e2e.qc774. and end with @quarryconnect.test.', 1;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].dbo.Users WHERE Id = @UserId AND NormalizedEmail = UPPER(@Email));
IF @PasswordHash IS NULL
    THROW 50004, 'The throwaway Identity vendor does not exist; run identity-qc774-user.apply.sql first.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);
DELETE app.DriverInvites WHERE VendorID_FK IN (SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = @VendorName);
DELETE auth.Organisations WHERE ParentOrganisationIdFk IN (SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = @VendorName)
    AND OrganisationName LIKE N'E2E QC-774 Truck%';
DELETE auth.Organisations WHERE OrganisationName = @VendorName AND ParentOrganisationIdFk = @HostOrganisationId;

INSERT auth.Organisations
(
    ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, IsInvestmentFirm, RejectedEULA,
    RoleTypeIdFk, ReadOnly, UseClientIDInFileNames, UpdatedOn, UpdatedBy, IsActive
)
VALUES (@HostOrganisationId, @VendorName, 'E2E774V', 0, 0, 0, @VendorType, 0, 0, GETUTCDATE(), 'e2e-qc774', 1);
DECLARE @VendorId int = SCOPE_IDENTITY();

INSERT auth.Organisations
(
    ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, IsInvestmentFirm, RejectedEULA,
    RoleTypeIdFk, ReadOnly, UseClientIDInFileNames, UpdatedOn, UpdatedBy, IsActive
)
VALUES
    (@VendorId, N'E2E QC-774 Truck 1', 'E2E774T1', 0, 0, 0, @TruckType, 0, 0, GETUTCDATE(), 'e2e-qc774', 1),
    (@VendorId, N'E2E QC-774 Truck 2', 'E2E774T2', 0, 0, 0, @TruckType, 0, 0, GETUTCDATE(), 'e2e-qc774', 1);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, Discriminator, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'Users', N'E2E', N'QC-774 Vendor',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @VendorId, 0, 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Vendor');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
