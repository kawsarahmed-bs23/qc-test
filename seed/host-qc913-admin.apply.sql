-- QC-913: the host Admin who creates and invites users in tests/app/user-invites.spec.ts: a host-database user with the host
-- role Admin for the throwaway Identity login $(UserId) ($(Email)) (Identity sub = host auth.Users.Id), in the host organisation
-- (EnvironmentSetting HostOrganisationId), with the live EULA signed. host-qc913.remove.sql deletes it with everything else.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @OrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));

IF @Email NOT LIKE N'e2e.qc913.%@example.com'
    THROW 50001, 'The host admin email must start with e2e.qc913. and end with @example.com.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50002, 'The host organisation does not exist in the host database.', 1;

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
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, 0,
    0, 1, 0, N'E2E', N'QC-913 Host admin', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Admin');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
