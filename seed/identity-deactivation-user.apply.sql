-- QC-738: a throwaway driver for the Identity administration API's user cases (IDADMIN-13, IDADMIN-14),
-- so deactivating a user never touches the shared test accounts.
-- It signs in with the test driver's password: its PasswordHash is copied from $(SourceEmail), which works
-- because an ASP.NET Identity password hash carries its own salt. Since QC-775 the password grant needs no host
-- mapping or role, so the user has none. Re-running replaces the user; remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc738.deactivate@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50001, 'The source test driver does not exist or has no password.', 1;

DECLARE @UserId nvarchar(450) = CONVERT(nvarchar(450), NEWID());

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
    0, 0, 1, 0, N'E2E', N'QC-738 Deactivate',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
