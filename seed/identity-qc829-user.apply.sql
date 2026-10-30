-- QC-829: one throwaway Identity driver, e2e.qc829.*@quarryconnect.test, for the driver sync cases (tests/26-driver-sync.spec.ts).
-- It signs in with the password of $(SourceEmail) (its PasswordHash is copied; an ASP.NET Identity hash carries its own salt).
-- It has no two-step verification, no role and no host data: host-side data comes from host-qc829-driver.apply.sql, the
-- driver-host links from drivers-qc829.apply.sql. Re-running replaces the user; identity-qc829.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';

IF @Email NOT LIKE N'e2e.qc829.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc829. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

BEGIN TRANSACTION;

DELETE c FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE l FROM PasswordResetLinks l JOIN Users u ON u.Id = l.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

INSERT Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
VALUES
(
    LOWER(CONVERT(nvarchar(36), NEWID())), @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'$(LastName)',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
