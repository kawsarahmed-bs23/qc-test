-- QC-709: removes every throwaway driver added by identity-qc709-driver.apply.sql (e2e.qc709.*@quarryconnect.test),
-- with its reset codes, grants and sessions. PasswordResetCodes has no foreign key, so its rows are deleted first;
-- the host mapping, roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);

INSERT @Users SELECT Id FROM Users WHERE NormalizedEmail LIKE N'E2E.QC709.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE PersistedGrants WHERE SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Id FROM @Users);
DELETE Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
