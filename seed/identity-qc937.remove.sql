-- QC-937: removes every e2e.qc937.*@quarryconnect.test user added by identity-qc937-user.apply.sql, with their reset codes
-- and links, grants and sessions. Roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC937.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
