-- QC-726: one throwaway Identity user, e2e.qc726.*@quarryconnect.test, so the sign-in claim cases (SIGNIN-*) sign in to the host API without the shared accounts.
-- It signs in with the password of $(SourceEmail): its PasswordHash is copied, which works because an ASP.NET Identity
-- password hash carries its own salt.
--   $(TwoFactor) 1 turns two-step verification on with the authenticator key $(AuthenticatorKey) (base32, made by the test
--   run, never stored anywhere but here and the git-ignored .auth folder); 0 leaves it off and stores no key
--   (pass AuthenticatorKey none: sqlcmd treats an empty variable as undefined).
-- Tokens carry no role since QC-775, so the user gets no Identity role and no host data.
-- Re-running replaces the user; identity-qc726.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @TwoFactor bit = $(TwoFactor);
DECLARE @AuthenticatorKey nvarchar(100) = N'$(AuthenticatorKey)';

IF @Email NOT LIKE N'e2e.qc726.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc726. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

IF @TwoFactor = 1 AND LEN(@AuthenticatorKey) < 16
    THROW 50003, 'Two-step verification needs an authenticator key.', 1;

BEGIN TRANSACTION;

DELETE c FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE l FROM PasswordResetLinks l JOIN Users u ON u.Id = l.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

DECLARE @UserId nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));

INSERT Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, @TwoFactor, 1, 0, N'E2E', N'$(LastName)',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

IF @TwoFactor = 1
    INSERT UserTokens (UserId, LoginProvider, Name, Value) VALUES (@UserId, N'[AspNetUserStore]', N'AuthenticatorKey', @AuthenticatorKey);

COMMIT TRANSACTION;
