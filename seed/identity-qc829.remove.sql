-- QC-829: removes every e2e.qc829.*@quarryconnect.test user added by identity-qc829-user.apply.sql, with their reset codes
-- and links, grants and sessions. Roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM Users WHERE NormalizedEmail LIKE N'E2E.QC829.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE PersistedGrants WHERE SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Id FROM @Users);
DELETE Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
