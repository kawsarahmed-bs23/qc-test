-- QC-742: removes the e2e.qc742.* users added by identity-qc742-users.apply.sql, with their grants, sessions and roles.
-- Since QC-775 Identity keeps no hosts, so there are no host rows to remove; Admin-created hosts live only in HOST_MASTER
-- (master-e2e-hosts.remove.sql).
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DELETE g FROM auth.PersistedGrants g JOIN auth.Users u ON g.SubjectId = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE s FROM app.UserSessions s JOIN auth.Users u ON s.SubjectID = CONVERT(nvarchar(36), u.UserUUID) WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE r FROM auth.UserRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE auth.Users WHERE NormalizedEmail LIKE N'E2E.QC742.%';

COMMIT TRANSACTION;
