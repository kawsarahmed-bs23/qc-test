-- QC-616: removes the throwaway users added by identity-qc616-user.apply.sql (e2e.qc616.*@quarryconnect.test) with
-- their grants and server-side sessions. Run against the Identity database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC616.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users) OR SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users) OR SubjectID IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
