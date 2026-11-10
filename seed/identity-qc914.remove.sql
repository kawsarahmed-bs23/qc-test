-- QC-914: removes the Identity users the invite cases (INV-*) create through /invite, whose email is LIKE $(EmailLike)
-- (always inside qc914-e2e-*@example.test), with their reset codes and links, magic links, grants and sessions.
-- Their authenticator keys, passkeys, roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @EmailLike nvarchar(256) = N'$(EmailLike)';

IF @EmailLike NOT LIKE N'qc914-e2e-%@example.test'
    THROW 50001, 'Only qc914-e2e-*@example.test users can be removed by this script.', 1;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE Email LIKE @EmailLike AND NormalizedEmail LIKE N'QC914-E2E-%@EXAMPLE.TEST';

BEGIN TRANSACTION;

DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.MagicLinkTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users) OR SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users) OR SubjectID IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;
