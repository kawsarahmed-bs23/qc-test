-- QC-913: removes every e2e.qc913.*@example.com Identity login: the ones identity-qc913-user.apply.sql seeds and the ones
-- the invite page creates when a test accepts a host invite as a new login, with their reset codes and links, magic links,
-- grants and sessions. Their authenticator keys, roles and claims go with the user (cascade).
-- Prints REMOVED users=<n>;left=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY, Subject nvarchar(36) NOT NULL);
INSERT @Users SELECT Id, CONVERT(nvarchar(36), UserUUID) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM';

BEGIN TRANSACTION;

DELETE auth.PasswordResetCodes WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.MagicLinkTokens', N'U') IS NOT NULL
    DELETE auth.MagicLinkTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.PersistedGrants WHERE SubjectId IN (SELECT Subject FROM @Users) OR SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Subject FROM @Users) OR SubjectID IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

COMMIT TRANSACTION;

DECLARE @Removed int = (SELECT COUNT(*) FROM @Users);
DECLARE @Left int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM');
PRINT CONCAT('REMOVED users=', @Removed, ';left=', @Left);
