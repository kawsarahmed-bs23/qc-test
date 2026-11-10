-- QC-826: removes the throwaway users added by identity-qc826-user.apply.sql whose email is LIKE $(EmailLike)
-- (always inside e2e.qc826.*@quarryconnect.test), with their reset codes and links, grants and sessions.
-- Their authenticator keys, roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @EmailLike nvarchar(256) = N'$(EmailLike)';

IF @EmailLike NOT LIKE N'e2e.qc826.%'
    THROW 50001, 'Only e2e.qc826.* users can be removed by this script.', 1;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE Email LIKE @EmailLike AND NormalizedEmail LIKE N'E2E.QC826.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
