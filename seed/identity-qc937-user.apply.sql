-- QC-937: one throwaway Identity driver, e2e.qc937.*@quarryconnect.test, for the linked-driver reply confirmation cases
-- (tests/app/reply-confirmation.spec.ts). Id and UserUUID are $(UserId), the sub of its tokens. It signs in with the password
-- of $(SourceEmail) (its PasswordHash is copied). Re-running replaces the user; identity-qc937.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @UserId nvarchar(450) = LOWER(N'$(UserId)');

IF @Email NOT LIKE N'e2e.qc937.%@quarryconnect.test'
    THROW 50001, 'The throwaway user email must start with e2e.qc937. and end with @quarryconnect.test.', 1;
IF TRY_CONVERT(uniqueidentifier, @UserId) IS NULL
    THROW 50003, 'UserId must be a GUID.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist or has no password.', 1;

BEGIN TRANSACTION;

DELETE c FROM auth.PasswordResetCodes c JOIN auth.Users u ON u.Id = c.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE l FROM auth.PasswordResetLinks l JOIN auth.Users u ON u.Id = l.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

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
    0, 0, 1, 0, N'E2E', N'QC-937 Linked driver',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

COMMIT TRANSACTION;
