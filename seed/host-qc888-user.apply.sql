-- QC-888: one throwaway host-database user, e2e.qc888.*@quarryconnect.test, for the EULA status and reset cases (EULA-*).
--   $(UserId)          the host auth.Users.Id: the Identity user's Id when the user signs in through Identity
--                      (Identity sub = host Id), or a fresh id for a user who never signs in.
--   $(Role)            the host role (Admin, Vendor, Driver).
--   $(OrganisationId)  the user's organisation (30 = the host, 34 = vendor TV, 38 = TV's truck Truck0001).
--   $(Eula)            rejected: RejectedEULA = 1 with RejectedEULAOn = $(EulaOnUtc);
--                      accepted: an auth.UserSignedEULAs row for the latest live doc created at $(EulaOnUtc);
--                      none: neither.
--   $(EulaOnUtc)       'yyyy-MM-dd HH:mm:ss', stored as UTC (the API reads both columns as UTC since QC-888).
-- Re-running replaces the user; host-qc888.remove.sql deletes every e2e.qc888.* user with what the cases leave behind.
-- Run against the host database (LOCAL_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @Role nvarchar(256) = N'$(Role)';
DECLARE @OrganisationId int = $(OrganisationId);
DECLARE @Eula nvarchar(20) = N'$(Eula)';
DECLARE @EulaOnUtc datetime2 = CONVERT(datetime2, N'$(EulaOnUtc)', 120);

IF @Email NOT LIKE N'e2e.qc888.%@quarryconnect.test'
    THROW 50001, 'The user email must start with e2e.qc888. and end with @quarryconnect.test.', 1;
IF @Role NOT IN (N'Admin', N'Vendor', N'Driver')
    THROW 50002, 'The role must be Admin, Vendor or Driver.', 1;
IF @Eula NOT IN (N'rejected', N'accepted', N'none')
    THROW 50003, 'Eula must be rejected, accepted or none.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE Id = @UserId AND NormalizedEmail NOT LIKE N'E2E.QC888.%@QUARRYCONNECT.TEST')
    THROW 50006, 'The user id belongs to a user that is not an e2e.qc888 throwaway.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50004, 'The organisation does not exist in the host database.', 1;

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
    0, 1, 0, N'E2E', N'QC-888 ' + @Role, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    CASE WHEN @Eula = N'rejected' THEN 1 ELSE 0 END, CASE WHEN @Eula = N'rejected' THEN @EulaOnUtc END,
    0, @OrganisationId, 0, 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, @Role);

IF @Eula = N'accepted'
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, @EulaOnUtc);

COMMIT TRANSACTION;
