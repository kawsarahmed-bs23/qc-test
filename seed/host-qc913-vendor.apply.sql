-- QC-913: host-side data for the Vendor Portal invite case (UINV-09 in tests/app/user-invites.spec.ts), in the host database:
--   * a throwaway vendor organisation 'E2E QC-913 Vendor' (role type Vendor) under the host organisation
--     (EnvironmentSetting HostOrganisationId), with two trucks 'E2E QC-913 Truck 1' and 'E2E QC-913 Truck 2' (role type Truck),
--   * the vendor user $(UserId) ($(Email)) in that organisation with the host role Vendor, the live EULA signed and the
--     password hash of the Identity login with the same Id, read from [$(IdentityDb)] (same server), so the Identity sign-in
--     of the host app works.
-- The driver users the vendor creates and invites are removed by host-qc913.remove.sql, which also removes all of this.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @VendorName nvarchar(200) = N'E2E QC-913 Vendor';

IF @Email NOT LIKE N'e2e.qc913.%@example.com'
    THROW 50001, 'The vendor email must start with e2e.qc913. and end with @example.com.', 1;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE Id = @UserId AND NormalizedEmail = UPPER(@Email));
IF @PasswordHash IS NULL
    THROW 50004, 'The throwaway Identity vendor does not exist; run identity-qc913-user.apply.sql first.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);
DELETE auth.Organisations WHERE ParentOrganisationIdFk IN (SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = @VendorName)
    AND OrganisationName LIKE N'E2E QC-913 Truck%';
DELETE auth.Organisations WHERE OrganisationName = @VendorName AND ParentOrganisationIdFk = @HostOrganisationId;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc913'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, @VendorName, 'E2E913V', @VendorType;
DECLARE @VendorId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = @VendorName);

EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E QC-913 Truck 1', 'E2E913T1', @TruckType;
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E QC-913 Truck 2', 'E2E913T2', @TruckType;

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-913 Vendor',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @VendorId, 0, 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Vendor');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
