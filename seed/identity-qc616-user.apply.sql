-- QC-616: copies the throwaway host user $(Email) (e2e.qc616.*@quarryconnect.test) from the host database
-- [$(HostDatabase)] into Identity with the column mapping of quarryconnect-sql identity/copy_host_users.sql: same Id and
-- UserUUID (the token's sub), the host PasswordHash unchanged. Only this one user is copied;
-- the real script copies every host user and is never run by the tests. identity-qc616.remove.sql deletes it.
-- Identity makes a host admin enrol in two-step verification after the password, so the user is then given the
-- authenticator key $(AuthenticatorKey) (base32, made by the test run) as if it had enrolled; the copy itself turns
-- two-step off. Run against the Identity database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @AuthenticatorKey nvarchar(100) = N'$(AuthenticatorKey)';

IF @Email NOT LIKE N'e2e.qc616.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc616. and end with @quarryconnect.test.', 1;
IF NOT EXISTS (SELECT 1 FROM [$(HostDatabase)].auth.Users WHERE NormalizedEmail = UPPER(@Email))
    THROW 50002, 'Seed the host user first (host-qc616-user.apply.sql).', 1;

BEGIN TRANSACTION;

DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId IN (u.Id, CONVERT(nvarchar(36), u.UserUUID)) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID IN (u.Id, CONVERT(nvarchar(36), u.UserUUID)) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE t FROM auth.UserTokens t JOIN auth.Users u ON u.Id = t.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users (
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed,
    PasswordHash, SecurityStamp, ConcurrencyStamp, PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled,
    LockoutEnd, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive)
SELECT h.Id, h.UserUUID, h.UserName, h.NormalizedUserName, h.Email, h.NormalizedEmail, h.EmailConfirmed,
       h.PasswordHash, ISNULL(h.SecurityStamp, CONVERT(nvarchar(36), NEWID())), ISNULL(h.ConcurrencyStamp, CONVERT(nvarchar(36), NEWID())),
       h.PhoneNumber, h.PhoneNumberConfirmed, 0,
       NULL, h.LockoutEnabled, h.AccessFailedCount, h.FirstName, h.LastName,
       ISNULL(h.CreateDate, SYSDATETIMEOFFSET()),
       COALESCE(h.LastLoginDate, h.CreateDate, SYSDATETIMEOFFSET()),
       COALESCE(h.LastPasswordChangedDate, h.CreateDate, SYSDATETIMEOFFSET()),
       ISNULL(h.PasswordResetFlag, 0),
       ISNULL(h.IsActive, 1)
FROM   [$(HostDatabase)].auth.Users AS h
WHERE  h.NormalizedEmail = UPPER(@Email);

IF LEN(@AuthenticatorKey) >= 16
BEGIN
    UPDATE auth.Users SET TwoFactorEnabled = 1 WHERE NormalizedEmail = UPPER(@Email);
    INSERT auth.UserTokens (UserId, LoginProvider, Name, Value)
    SELECT Id, N'[AspNetUserStore]', N'AuthenticatorKey', @AuthenticatorKey FROM auth.Users WHERE NormalizedEmail = UPPER(@Email);
END;

COMMIT TRANSACTION;
