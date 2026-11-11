-- QC-616: removes the host-database users added by host-qc616-user.apply.sql (e2e.qc616.*@quarryconnect.test) with
-- their EULA signatures and the identity sessions, refresh tokens and login history a sign-in leaves. Run against the
-- host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC616.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc616.%@quarryconnect.test';
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
