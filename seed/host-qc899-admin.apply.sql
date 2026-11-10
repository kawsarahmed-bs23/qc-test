-- QC-899: a host-database user with the host role Admin for the throwaway Identity user $(UserId) ($(Email)), so the
-- auth-cleanup cases (tests/35-auth-cleanup.spec.ts) reach the host API as a host administrator through the identity
-- exchange (Identity sub = host auth.Users.Id). Placed in the host organisation, with the live EULA signed and the
-- Identity user's PasswordHash copied from [$(IdentityDb)] so AUTHCLEAN-05 can change the password through the host API.
-- Inserts only columns that exist with and without QC-899. Run against the host database (LOCAL_SQL_DATABASE);
-- host-qc899.remove.sql deletes it with everything the cases leave.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @OrganisationId int = (SELECT TOP 1 CONVERT(int, PropertyValue) FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId');

IF @Email NOT LIKE N'e2e.qc899.%@quarryconnect.test'
    THROW 50001, 'The host admin email must start with e2e.qc899. and end with @quarryconnect.test.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50002, 'The host organisation does not exist in the host database.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE Id = @UserId AND NormalizedEmail = UPPER(@Email));
IF @PasswordHash IS NULL
    THROW 50003, 'The Identity user does not exist or has no password.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash, 0,
    0, 1, 0, N'E2E', N'QC-899 Host admin', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), DATEADD(DAY, -1, SYSDATETIMEOFFSET()),
    0, 0, @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Admin');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
