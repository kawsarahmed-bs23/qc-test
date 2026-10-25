-- QC-742: removes the e2e.qc742.* users added by identity-qc742-users.apply.sql, with their grants, sessions and roles.
-- Since QC-775 Identity keeps no hosts, so there are no host rows to remove; Admin-created hosts live only in HOST_MASTER
-- (master-e2e-hosts.remove.sql).
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE r FROM UserRoles r JOIN Users u ON u.Id = r.UserId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE Users WHERE NormalizedEmail LIKE N'E2E.QC742.%';

COMMIT TRANSACTION;
