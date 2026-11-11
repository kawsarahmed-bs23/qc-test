-- QC-800: removes the throwaway host users e2e.qc800.*@example.com that tests/app/14-host-password-link.spec.ts creates
-- through POST api/manageusers/user-create, with the roles, password history, sign-in history, refresh tokens, identity
-- sessions, EULA signatures, audit rows and the auth.SystemNotifications rows of the emails sent to them, and the EmailUserCreatedAudit
-- rows (sent to EmailSettings:RecipientEmails) whose body names one of them.
-- Run against the host database (LOCAL_SQL_DATABASE). Prints REMOVED users=<n>;notifications=<n>;left=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC800.%@EXAMPLE.COM';

DECLARE @UserCount int = (SELECT COUNT(*) FROM @Users);
DECLARE @NotificationCount int;

BEGIN TRANSACTION;

DELETE auth.SystemNotifications WHERE NotifcationTo LIKE N'e2e.qc800.%@example.com'
    OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.qc800.%@example.com%');
SET @NotificationCount = @@ROWCOUNT;
DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc800.%@example.com';
IF OBJECT_ID(N'auth.PasswordHistories', N'U') IS NOT NULL
    DELETE auth.PasswordHistories WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;

DECLARE @Left int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC800.%@EXAMPLE.COM');
PRINT CONCAT('REMOVED users=', @UserCount, ';notifications=', @NotificationCount, ';left=', @Left);
