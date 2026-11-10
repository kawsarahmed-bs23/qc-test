-- QC-909: removes every host-database user added by host-qc909-user.apply.sql (e2e.qc909.*@quarryconnect.test) with
-- their EULA acceptances (the seeded ones and the ones HEULA-* make through Accept), and the identity sessions, refresh
-- tokens, login history and audit rows a sign-in leaves. Run against the host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC909.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc909.%@quarryconnect.test';
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
