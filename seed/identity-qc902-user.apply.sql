-- QC-902: one throwaway Identity driver, e2e.qc902.*@quarryconnect.test, for the Driver settings and as-hauled cases (tests/34-driver-settings.spec.ts).
-- It signs in with the password of $(SourceEmail) (its PasswordHash is copied; an ASP.NET Identity hash carries its own salt).
-- It has no two-step verification, no role and no host data: its DRIVERS rows (link, assignment, message, account) come from
-- drivers-qc902.apply.sql and drivers-qc902-account.apply.sql. Re-running replaces the user; identity-qc902.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';

IF @Email NOT LIKE N'e2e.qc902.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc902. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

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
    0, 0, 1, 0, N'E2E', N'$(LastName)',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
