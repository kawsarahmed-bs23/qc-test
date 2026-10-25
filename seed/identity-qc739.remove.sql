-- QC-739: removes the throwaway member user added by identity-qc739-member.apply.sql, with its grants and sessions.
-- Since QC-775 Identity keeps no hosts, so there are no e2e-qc739 host rows left to remove here.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc739.member@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

COMMIT TRANSACTION;
