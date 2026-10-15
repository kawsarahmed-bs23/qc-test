-- QC-739: removes what the QC-739 cases leave in Identity: the throwaway member user, and every host whose key
-- starts with e2e-qc739 with its mappings, branding, features and clients. Host delete through the API is refused
-- once a user has been mapped, so the cases cannot clean up after themselves.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc739.member@quarryconnect.test';
DECLARE @Hosts TABLE (HostID int PRIMARY KEY);

INSERT @Hosts SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc739%';

BEGIN TRANSACTION;

DELETE g FROM PersistedGrants g JOIN Users u ON u.Id = g.SubjectId WHERE u.NormalizedEmail = UPPER(@Email);
DELETE s FROM app.UserSessions s JOIN Users u ON u.Id = s.SubjectID WHERE u.NormalizedEmail = UPPER(@Email);
DELETE Users WHERE NormalizedEmail = UPPER(@Email);

DELETE Clients WHERE ClientId LIKE N'e2e-qc739.%' OR ClientId IN (SELECT ClientID FROM app.HostClients WHERE HostID IN (SELECT HostID FROM @Hosts));
DELETE app.UserHosts WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostClients WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostBrandings WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.HostFeatures WHERE HostID IN (SELECT HostID FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT HostID FROM @Hosts);

COMMIT TRANSACTION;
