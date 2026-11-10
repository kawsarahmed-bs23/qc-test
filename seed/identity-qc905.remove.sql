-- QC-905: removes every throwaway user added by identity-qc905-user.apply.sql (e2e.qc905.*@quarryconnect.test, also after
-- an email change moved it to another e2e.qc905.* address) with its email change requests (auth.EmailChangeRequests),
-- reset codes and links, grants and sessions. Authenticator keys, roles and claims go with the user (cascade).
-- Run against Identity's database (IDENTITY_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC905.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.EmailChangeRequests WHERE UserId IN (SELECT Id FROM @Users) OR NewEmail LIKE N'e2e.qc905.%@quarryconnect.test';
DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
