-- QC-739: removes the throwaway member user added by identity-qc739-member.apply.sql, with its grants and sessions.
-- Since QC-775 Identity keeps no hosts, so there are no e2e-qc739 host rows left to remove here.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc739.member@quarryconnect.test';

BEGIN TRANSACTION;

DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail = UPPER(@Email);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

COMMIT TRANSACTION;
