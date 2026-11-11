-- QC-913: one throwaway Identity login, e2e.qc913.*@example.com, for the user invite cases (tests/app/user-invites.spec.ts):
-- the vendor who signs in to the host app (two-step on) and the person who already has a login when the invite arrives
-- (two-step off). It signs in with the password of $(SourceEmail): its PasswordHash is copied, which works because an
-- ASP.NET Identity password hash carries its own salt.
--   $(TwoFactor) 1 turns two-step verification on with the authenticator key $(AuthenticatorKey) (base32, made by the test
--   run); 0 leaves it off (pass AuthenticatorKey none: sqlcmd treats an empty variable as undefined).
-- Re-running replaces the login; identity-qc913.remove.sql deletes every e2e.qc913.* login, including the ones the invite
-- page creates.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @TwoFactor bit = $(TwoFactor);
DECLARE @AuthenticatorKey nvarchar(100) = N'$(AuthenticatorKey)';

IF @Email NOT LIKE N'e2e.qc913.%@example.com'
    THROW 50001, 'The throwaway login email must start with e2e.qc913. and end with @example.com.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

IF @TwoFactor = 1 AND LEN(@AuthenticatorKey) < 16
    THROW 50003, 'Two-step verification needs an authenticator key.', 1;

BEGIN TRANSACTION;

DELETE c FROM auth.PasswordResetCodes c JOIN auth.Users u ON u.Id = c.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE l FROM auth.PasswordResetLinks l JOIN auth.Users u ON u.Id = l.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

DECLARE @UserId nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
VALUES
(
    @UserId, CONVERT(uniqueidentifier, @UserId), @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, @TwoFactor, 1, 0, N'E2E', N'$(LastName)',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

IF @TwoFactor = 1
    INSERT auth.UserTokens (UserId, LoginProvider, Name, Value) VALUES (@UserId, N'[AspNetUserStore]', N'AuthenticatorKey', @AuthenticatorKey);

COMMIT TRANSACTION;
