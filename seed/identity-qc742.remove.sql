-- QC-742: removes what the QC-742 cases leave in Identity: the e2e.qc742.* users (with their grants, sessions,
-- host mappings and roles), and every host whose key starts with e2e-qc742 with its mappings, branding, features
-- and clients (hosts created by the @create cases through Admin).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Hosts TABLE (HostID int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc742%';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE m FROM app.UserHosts m JOIN Users u ON u.Id = m.UserID WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE r FROM UserRoles r JOIN Users u ON u.Id = r.UserId WHERE u.NormalizedEmail LIKE N'E2E.QC742.%';
DELETE Users WHERE NormalizedEmail LIKE N'E2E.QC742.%';

DELETE Clients WHERE ClientId LIKE N'e2e-qc742.%' OR ClientId IN (SELECT ClientID FROM app.HostClients WHERE HostID IN (SELECT HostID FROM @Hosts));
DELETE app.UserHosts WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostClients WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
