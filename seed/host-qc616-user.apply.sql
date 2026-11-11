-- QC-616: a throwaway host-database user $(Email) (e2e.qc616.*@quarryconnect.test) with the host role Admin, for the
-- host cutover cases (CUT-*). Its PasswordHash is copied from the host user $(SourceEmail), so it signs in with that
-- password (an ASP.NET Identity v3 hash carries its own salt). Id and UserUUID are both $(UserId). Placed in the host
-- organisation 30 with the live EULA signed. identity-qc616-user.apply.sql then copies it into Identity the way
-- quarryconnect-sql identity/copy_host_users.sql does. host-qc616.remove.sql deletes it. Run against the host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @OrganisationId int = 30;

IF @Email NOT LIKE N'e2e.qc616.%@quarryconnect.test'
    THROW 50001, 'The host user email must start with e2e.qc616. and end with @quarryconnect.test.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50002, 'The host organisation does not exist in the host database.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT TOP 1 PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)') AND PasswordHash IS NOT NULL);
IF @PasswordHash IS NULL
    THROW 50003, 'The source host user does not exist or has no password.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, CONVERT(uniqueidentifier, @UserId), @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash, 0,
    0, 1, 0, N'E2E', N'QC-616 Host admin', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Admin');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
