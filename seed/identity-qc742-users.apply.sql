-- QC-742: 40 throwaway Identity users for the Admin users list (USRLIST-*) and Identity's /api/admin/users/list (IDADMIN-21..25).
-- e2e.qc742.u01 .. u40@quarryconnect.test, first name E2E. They never sign in, so they have no password.
--   Identity host 1: u01..u36, Driver when the number is odd, HostUser when even.
--   Identity host 2: u25..u40, HostUser when odd, Driver when even (u25..u36 are on both hosts with opposite roles).
--   Platform role Admin: u05 and u10. Deactivated: u07, u14, u21, u28, u35.
--   Last name "QC742 Lnn" and LastLoginDate are permutations of the numbers, so name, email and last-login orders all differ.
-- Re-running replaces the users; identity-qc742.remove.sql deletes them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Driver nvarchar(450) = (SELECT Id FROM Roles WHERE Name = N'Driver');
DECLARE @HostUser nvarchar(450) = (SELECT Id FROM Roles WHERE Name = N'HostUser');
DECLARE @Admin nvarchar(450) = (SELECT Id FROM Roles WHERE Name = N'Admin');
IF @Driver IS NULL OR @HostUser IS NULL OR @Admin IS NULL
    THROW 50001, 'The Driver, HostUser or Admin role is missing.', 1;
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostID = 1 AND Active = 1) OR NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostID = 2 AND Active = 1)
    THROW 50002, 'Identity hosts 1 and 2 must exist and be active.', 1;

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE m FROM app.UserHosts m JOIN Users u ON u.Id = m.UserID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE r FROM UserRoles r JOIN Users u ON u.Id = r.UserId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE Users WHERE NormalizedEmail LIKE N'E2E.QC742.%';

DECLARE @i int = 1;
WHILE @i <= 40
BEGIN
    DECLARE @Number nchar(2) = RIGHT(N'0' + CAST(@i AS nvarchar(2)), 2);
    DECLARE @Email nvarchar(256) = N'e2e.qc742.u' + @Number + N'@quarryconnect.test';
    DECLARE @UserId nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));

    INSERT Users
    (
        Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, SecurityStamp, ConcurrencyStamp,
        PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
        LastLoginDate, LastPasswordChangedDate, PasswordResetFlag, IsActive
    )
    VALUES
    (
        @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1,
        UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
        0, 0, 1, 0, N'E2E', N'QC742 L' + RIGHT(N'0' + CAST((@i * 17) % 41 AS nvarchar(2)), 2),
        DATEADD(minute, -((@i * 13) % 41), CAST('2026-01-01T12:00:00+00:00' AS datetimeoffset)), SYSDATETIMEOFFSET(), 0,
        CASE WHEN @i % 7 = 0 THEN 0 ELSE 1 END
    );

    IF @i <= 36
        INSERT app.UserHosts (UserID, HostID, OrganisationID, RoleID, CreatedBy, UpdatedBy)
        VALUES (@UserId, 1, 1, CASE WHEN @i % 2 = 1 THEN @Driver ELSE @HostUser END, N'e2e', N'e2e');

    IF @i >= 25
        INSERT app.UserHosts (UserID, HostID, OrganisationID, RoleID, CreatedBy, UpdatedBy)
        VALUES (@UserId, 2, 2, CASE WHEN @i % 2 = 1 THEN @HostUser ELSE @Driver END, N'e2e', N'e2e');

    IF @i IN (5, 10)
        INSERT UserRoles (UserId, RoleId) VALUES (@UserId, @Admin);

    SET @i += 1;
END;

COMMIT TRANSACTION;
