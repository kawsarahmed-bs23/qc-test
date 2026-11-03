-- QC-801: a host-database user for the throwaway Identity user $(UserId) ($(Email)) with the single host role $(RoleName)
-- in organisation $(OrganisationId), so the host API's identity exchange issues them a host JWT (Identity sub = host
-- auth.Users.Id). Admin in organisation 30 is a normal host administrator; SuperAdmin in organisation 1 is the old root
-- super admin, which needs superadmin-role-qc801.apply.sql first (auth.UserToRoles has a foreign key to
-- auth.RolesToPermissions). The live EULA is signed so sign-in returns to the app. Run against the host database
-- (LOCAL_SQL_DATABASE). host-qc801.remove.sql deletes it with the sessions, refresh tokens and login history a sign-in leaves.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @RoleName nvarchar(100) = N'$(RoleName)';
DECLARE @OrganisationId int = $(OrganisationId);

IF @Email NOT LIKE N'e2e.qc801.%@quarryconnect.test'
    THROW 50001, 'The host user email must start with e2e.qc801. and end with @quarryconnect.test.', 1;
IF @RoleName NOT IN (N'Admin', N'SuperAdmin')
    THROW 50002, 'The QC-801 host user is either Admin or SuperAdmin.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50003, 'The host organisation does not exist in the host database.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.RolesToPermissions WHERE RoleName = @RoleName)
    THROW 50004, 'The role is not in auth.RolesToPermissions; for SuperAdmin run superadmin-role-qc801.apply.sql first.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, Discriminator, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, 0,
    0, 1, 0, N'E2E', N'QC-801 ' + @RoleName, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, N'Users', @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, @RoleName);

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
