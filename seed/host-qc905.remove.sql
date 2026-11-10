-- QC-905: removes every host-database user added by host-qc905-user.apply.sql (e2e.qc905.*@quarryconnect.test, also after
-- an edit or a sign-in moved it to another e2e.qc905.* address) with the audit rows an edit or an email sync writes for
-- them and the sessions, refresh tokens, claims and login history a sign-in leaves. Run against the host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC905.%@QUARRYCONNECT.TEST' OR NormalizedUserName LIKE N'E2E.QC905.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc905.%@quarryconnect.test';
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserLogins WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
