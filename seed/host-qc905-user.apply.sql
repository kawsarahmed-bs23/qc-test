-- QC-905: one throwaway host-database user, e2e.qc905.*@quarryconnect.test, for the login email lock cases (EMLCHG-*).
--   $(UserId)          the host auth.Users.Id: the Identity user's Id when the user signs in through Identity
--                      (the first sign-in links the host user to that identity), or a fresh id for a user who never signs in.
--   $(Role)            the host role (Admin, Vendor, Driver).
--   $(OrganisationId)  the user's organisation (30 = the host, 34 = vendor TV, 38 = TV's truck Truck0001).
--   $(UserUuid)        the Identity UserUUID the host user is linked to (its invite was accepted, so the email is locked),
--                      or none for a user who has not accepted an invite yet (UserUUID NULL, email editable).
-- The live EULA is signed, so a sign-in lands in the app. Re-running replaces the user; host-qc905.remove.sql deletes
-- every e2e.qc905.* user with what the cases leave behind.
-- Run against the host database (LOCAL_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @Role nvarchar(256) = N'$(Role)';
DECLARE @OrganisationId int = $(OrganisationId);
DECLARE @UserUuidText nvarchar(36) = N'$(UserUuid)';
DECLARE @UserUuid uniqueidentifier = CASE WHEN @UserUuidText = N'none' THEN NULL ELSE CONVERT(uniqueidentifier, @UserUuidText) END;

IF @Email NOT LIKE N'e2e.qc905.%@quarryconnect.test'
    THROW 50001, 'The user email must start with e2e.qc905. and end with @quarryconnect.test.', 1;
IF @Role NOT IN (N'Admin', N'Vendor', N'Driver')
    THROW 50002, 'The role must be Admin, Vendor or Driver.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE Id = @UserId AND NormalizedEmail NOT LIKE N'E2E.QC905.%@QUARRYCONNECT.TEST')
    THROW 50003, 'The user id belongs to a user that is not an e2e.qc905 throwaway.', 1;
IF @UserUuid IS NOT NULL AND EXISTS (SELECT 1 FROM auth.Users WHERE UserUUID = @UserUuid AND NormalizedEmail NOT LIKE N'E2E.QC905.%@QUARRYCONNECT.TEST')
    THROW 50004, 'The UserUUID belongs to a user that is not an e2e.qc905 throwaway.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50005, 'The organisation does not exist in the host database.', 1;

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DECLARE @Old TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Old SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email) OR Id = @UserId;

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Old);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Old);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Old);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Old);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @UserUuid, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, 0,
    0, 1, 0, N'E2E', N'QC-905 ' + @Role, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, @OrganisationId,
    ISNULL((SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL AND OrganisationLocationIdFk > 0), 0),
    1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, @Role);

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSUTCDATETIME());

COMMIT TRANSACTION;
