-- QC-993: a throwaway host administrator, e2e.qc993.*@quarryconnect.test, that signs in to the host app with a password
-- (no Identity account). Its PasswordHash is copied from the host user $(SourceEmail), so it takes that user's password;
-- an ASP.NET Identity hash carries its own salt. Placed in the host organisation 30 with the live EULA signed, so a
-- sign-in lands on the dashboard. Run against the host database (LOCAL_SQL_DATABASE). Re-running replaces the user;
-- host-qc993.remove.sql deletes it with the sessions, refresh tokens and login history a sign-in leaves.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @OrganisationId int = 30;

IF @Email NOT LIKE N'e2e.qc993.%@quarryconnect.test'
    THROW 50001, 'The throwaway email must start with e2e.qc993. and end with @quarryconnect.test.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50002, 'The host organisation does not exist in the host database.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50003, 'The source host user does not exist or has no password.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

DECLARE @UserId nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));

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
    0, 1, 0, N'E2E', N'QC-993 Session', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Admin');

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
