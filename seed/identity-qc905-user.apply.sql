-- QC-905: one throwaway Identity user, e2e.qc905.*@quarryconnect.test, for the login email change cases (EMLCHG-*):
-- the person whose login email support changes, the login that already holds an email, and the host admin or vendor who
-- signs in to the host app to edit users.
-- It signs in with the password of $(SourceEmail): its PasswordHash is copied, which works because an ASP.NET Identity
-- password hash carries its own salt.
--   $(TwoFactor) 1 turns two-step verification on with the authenticator key $(AuthenticatorKey) (base32, made by the test
--   run, never stored anywhere but here and the git-ignored .auth folder); 0 leaves it off and stores no key
--   (pass AuthenticatorKey none: sqlcmd treats an empty variable as undefined).
-- Re-running replaces the user; identity-qc905.remove.sql deletes it with its email change requests.
-- Run against Identity's database (IDENTITY_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @TwoFactor bit = $(TwoFactor);
DECLARE @AuthenticatorKey nvarchar(100) = N'$(AuthenticatorKey)';

IF @Email NOT LIKE N'e2e.qc905.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc905. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

IF @TwoFactor = 1 AND LEN(@AuthenticatorKey) < 16
    THROW 50003, 'Two-step verification needs an authenticator key.', 1;

BEGIN TRANSACTION;

DELETE r FROM auth.EmailChangeRequests r JOIN auth.Users u ON u.Id = r.UserId WHERE u.NormalizedEmail = UPPER(@Email);
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
