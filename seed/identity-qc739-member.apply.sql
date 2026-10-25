-- QC-739: a throwaway Identity user for the user cases (IDADMIN-16, IDADMIN-19, HU-03, HU-05).
-- It never signs in, so it has no password. Deactivating and reactivating it never touches
-- the shared test accounts. Re-running replaces the user; identity-qc739.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc739.member@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

INSERT Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
VALUES
(
    CONVERT(nvarchar(450), NEWID()), @Email, UPPER(@Email), @Email, UPPER(@Email), 1,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-739 Member',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
