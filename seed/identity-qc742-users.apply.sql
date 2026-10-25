-- QC-742: 40 throwaway Identity users for the Admin users list (USRLIST-*) and Identity's /api/admin/users/list (IDADMIN-21..25).
-- e2e.qc742.u01 .. u40@quarryconnect.test, first name E2E. They never sign in, so they have no password.
-- Since QC-775 Identity has no host mappings and no platform roles, so the users have neither.
-- Deactivated: u07, u14, u21, u28, u35.
-- Last name "QC742 Lnn" and LastLoginDate are permutations of the numbers, so name, email and last-login orders all differ.
-- Re-running replaces the users; identity-qc742.remove.sql deletes them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
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

    SET @i += 1;
END;

COMMIT TRANSACTION;
