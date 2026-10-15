-- QC-738: removes the throwaway driver added by identity-deactivation-user.apply.sql, with its grants and sessions.
-- Its host mapping, roles and claims go with the user (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc738.deactivate@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

COMMIT TRANSACTION;
