-- QC-909: one throwaway host-database admin of the Host organisation, e2e.qc909.*@quarryconnect.test, for the host EULA
-- cases (HEULA-*).
--   $(UserId)  the Identity user's Id (Identity sub = host auth.Users.Id), from identity-qc909-user.apply.sql.
--   $(Eula)    accepted: an auth.UserSignedEULAs row for the live doc, written the way the API wrote it before QC-909
--              (no UserEULADocText), as a user who accepted before the EULA used {{HostName}};
--              none: no acceptance.
-- Re-running replaces the user; host-qc909.remove.sql deletes every e2e.qc909.* user with what the cases leave behind.
-- Run against the host database (LOCAL_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @Eula nvarchar(20) = N'$(Eula)';

IF @Email NOT LIKE N'e2e.qc909.%@quarryconnect.test'
    THROW 50001, 'The user email must start with e2e.qc909. and end with @quarryconnect.test.', 1;
IF @Eula NOT IN (N'accepted', N'none')
    THROW 50003, 'Eula must be accepted or none.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE Id = @UserId AND NormalizedEmail NOT LIKE N'E2E.QC909.%@QUARRYCONNECT.TEST')
    THROW 50006, 'The user id belongs to a user that is not an e2e.qc909 throwaway.', 1;

DECLARE @OrganisationId int = (SELECT TRY_CONVERT(int, PropertyValue) FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId');
IF @OrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50004, 'The HostOrganisationId setting does not name an organisation in the host database.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;
IF @Eula = N'accepted' AND @EulaDocId IS NULL
    THROW 50005, 'There is no live EULA document to sign.', 1;

BEGIN TRANSACTION;

DECLARE @Old TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Old SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email) OR Id = @UserId;

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Old);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Old);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Old);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, RejectedEULAOn, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, 0,
    0, 1, 0, N'E2E', N'QC-909 Admin', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, NULL, 0, @OrganisationId, 0, 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Admin');

IF @Eula = N'accepted'
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

COMMIT TRANSACTION;
