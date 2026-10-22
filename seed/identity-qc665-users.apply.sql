-- QC-665: throwaway users for host selection (HSEL-*), all e2e.qc665.<name>@quarryconnect.test.
-- They sign in with the test driver's password: each PasswordHash is copied from $(SourceEmail), which works because an
-- ASP.NET Identity password hash carries its own salt.
--   driver0   no host at all                               -> mobile no_host_available, web NoHost page
--   driver1   Driver at the mobile client's host            -> one-element hosts array, straight in
--   driver2   Driver at the mobile client's host and $(SecondHostKey) -> two hosts, picker
--   host1     HostUser at the mobile client's host          -> id.* lands on that host
--   host2     HostUser at both hosts                        -> id.* shows the picker
-- Safe to re-run: existing e2e.qc665.* users are removed first. identity-qc665.remove.sql deletes them all.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50001, 'The source test driver does not exist or has no password.', 1;

DECLARE @FirstHostId int = (SELECT HostID FROM app.HostClients WHERE ClientID = N'$(MobileClientId)' AND Active = 1);
IF @FirstHostId IS NULL
    THROW 50002, 'The mobile client belongs to no active host.', 1;

DECLARE @SecondHostId int = (SELECT HostID FROM app.Hosts WHERE HostKey = N'$(SecondHostKey)' AND Active = 1);
IF @SecondHostId IS NULL OR @SecondHostId = @FirstHostId
    THROW 50003, 'The second host must be an active host other than the mobile client''s host.', 1;

DECLARE @DriverRole nvarchar(450) = (SELECT Id FROM Roles WHERE Name = N'Driver');
DECLARE @HostUserRole nvarchar(450) = (SELECT Id FROM Roles WHERE Name = N'HostUser');

DECLARE @Seed TABLE (Name nvarchar(20), HostId int, RoleId nvarchar(450));
INSERT @Seed VALUES
    (N'driver0', NULL, NULL),
    (N'driver1', @FirstHostId, @DriverRole),
    (N'driver2', @FirstHostId, @DriverRole),
    (N'driver2', @SecondHostId, @DriverRole),
    (N'host1', @FirstHostId, @HostUserRole),
    (N'host2', @FirstHostId, @HostUserRole),
    (N'host2', @SecondHostId, @HostUserRole);

DECLARE @Old TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Old SELECT Id FROM Users WHERE NormalizedEmail LIKE N'E2E.QC665.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE PersistedGrants WHERE SubjectId IN (SELECT Id FROM @Old);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Id FROM @Old);
DELETE Users WHERE Id IN (SELECT Id FROM @Old);

INSERT Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
)
SELECT
    LOWER(CONVERT(nvarchar(450), NEWID())), e.Email, UPPER(e.Email), e.Email, UPPER(e.Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', N'QC-665 ' + s.Name,
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), 0, 1
FROM (SELECT DISTINCT Name FROM @Seed) AS s
CROSS APPLY (SELECT N'e2e.qc665.' + s.Name + N'@quarryconnect.test' AS Email) AS e;

INSERT app.UserHosts (UserID, HostID, OrganisationID, RoleID, CreatedBy, UpdatedBy)
SELECT u.Id, s.HostId, 1, s.RoleId, N'e2e', N'e2e'
FROM @Seed AS s
JOIN Users AS u ON u.NormalizedEmail = UPPER(N'e2e.qc665.' + s.Name + N'@quarryconnect.test')
WHERE s.HostId IS NOT NULL;

COMMIT TRANSACTION;

SELECT u.Email, h.HostKey, h.HostUUID, r.Name AS Role
FROM Users AS u
LEFT JOIN app.UserHosts AS uh ON uh.UserID = u.Id AND uh.Active = 1
LEFT JOIN app.Hosts AS h ON h.HostID = uh.HostID
LEFT JOIN Roles AS r ON r.Id = uh.RoleID
WHERE u.NormalizedEmail LIKE N'E2E.QC665.%@QUARRYCONNECT.TEST'
ORDER BY u.Email, h.HostKey;
