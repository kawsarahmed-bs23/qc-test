-- QC-709: a throwaway driver for the mobile account API cases (ACC-*), so resetting and changing a password never
-- touches the shared test driver, and its per-address reset-request budget (3 per 15 minutes) is its own.
-- $(Email) is unique per run (e2e.qc709.<name>.<timestamp>@quarryconnect.test), so back-to-back runs never share a budget.
-- It signs in with the test driver's password: its PasswordHash is copied from $(SourceEmail), which works because an
-- ASP.NET Identity password hash carries its own salt. It is mapped as Driver to the host of $(MobileClientId), so the
-- password grant and the change-password grant accept it. identity-qc709.remove.sql deletes every e2e.qc709.* user.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';

IF @Email NOT LIKE N'e2e.qc709.%@quarryconnect.test'
    THROW 50003, 'The throwaway driver email must start with e2e.qc709. and end with @quarryconnect.test.', 1;

BEGIN TRANSACTION;

DELETE c FROM PasswordResetCodes c JOIN Users u ON u.Id = c.UserId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50001, 'The source test driver does not exist or has no password.', 1;

DECLARE @HostId int = (SELECT HostID FROM app.HostClients WHERE ClientID = N'$(MobileClientId)' AND Active = 1);
IF @HostId IS NULL
    THROW 50002, 'The mobile client belongs to no active host.', 1;

DECLARE @UserId nvarchar(450) = LOWER(CONVERT(nvarchar(450), NEWID()));

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
    0, 0, 1, 0, N'E2E', N'QC-709 Account',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
);

INSERT app.UserHosts (UserID, HostID, OrganisationID, RoleID, CreatedBy, UpdatedBy)
SELECT @UserId, @HostId, 1, Id, N'e2e', N'e2e' FROM Roles WHERE Name = N'Driver';

COMMIT TRANSACTION;
