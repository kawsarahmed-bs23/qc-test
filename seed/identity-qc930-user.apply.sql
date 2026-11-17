-- QC-930: one throwaway Identity driver, e2e.qc930.linked@quarryconnect.test, with Id and UserUUID $(UserId) (the same GUID as
-- the linked host user and DRIVERS user), so SMSRT-05 can get a Drivers API token by the password grant and call PUT me/settings.
-- It signs in with the password of $(SourceEmail) (its PasswordHash is copied; an ASP.NET Identity hash carries its own salt).
-- No two-step verification, no role. Re-running replaces the user; identity-qc930.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc930.linked@quarryconnect.test';
DECLARE @UserId nvarchar(450) = LOWER(N'$(UserId)');
IF TRY_CONVERT(uniqueidentifier, @UserId) IS NULL
    THROW 50001, 'UserId must be a GUID.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

BEGIN TRANSACTION;

DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email) OR u.Id = @UserId;
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email) OR u.Id = @UserId;
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email) OR Id = @UserId;

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
VALUES
(
    @UserId, CONVERT(uniqueidentifier, @UserId), @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    N'5125559301', 0, 0, 1, 0, N'E2E', N'QC-930 Linked',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
