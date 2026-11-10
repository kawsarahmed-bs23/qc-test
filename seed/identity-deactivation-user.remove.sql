-- QC-738: removes the throwaway driver added by identity-deactivation-user.apply.sql, with its grants and sessions.
-- Its roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc738.deactivate@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

COMMIT TRANSACTION;
