-- QC-899: one throwaway Identity user, e2e.qc899.*@quarryconnect.test, so the auth-cleanup cases (tests/35-auth-cleanup.spec.ts)
-- sign in as a host admin without the shared admin. It signs in with the password of $(SourceEmail): its PasswordHash is
-- copied, which works because an ASP.NET Identity password hash carries its own salt.
--   $(TwoFactor) 1 turns two-step verification on with the authenticator key $(AuthenticatorKey) (base32, made by the test
--   run, never stored anywhere but here); 0 leaves it off and stores no key (pass AuthenticatorKey none).
-- Tokens carry no role since QC-775, so the user gets no Identity role and no host data.
-- Re-running replaces the user; identity-qc899.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @TwoFactor bit = $(TwoFactor);
DECLARE @AuthenticatorKey nvarchar(100) = N'$(AuthenticatorKey)';

IF @Email NOT LIKE N'e2e.qc899.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc899. and end with @quarryconnect.test.', 1;

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
