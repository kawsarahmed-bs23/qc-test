-- QC-665: removes every throwaway user added by identity-qc665-users.apply.sql (e2e.qc665.*@quarryconnect.test),
-- with their grants and sessions; host mappings, roles and claims go with the user (cascade).
-- Also removes the e2e-qc665* hosts that HSEL creates through Identity's administration API, which has no delete for them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);

INSERT @Users SELECT Id FROM Users WHERE NormalizedEmail LIKE N'E2E.QC665.%@QUARRYCONNECT.TEST';

BEGIN TRANSACTION;

DELETE PersistedGrants WHERE SubjectId IN (SELECT Id FROM @Users);
DELETE app.UserSessions WHERE SubjectID IN (SELECT Id FROM @Users);
DELETE Users WHERE Id IN (SELECT Id FROM @Users);

DELETE app.HostClients WHERE HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc665%');
DELETE app.HostBrandings WHERE HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc665%');
DELETE app.HostFeatures WHERE HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey LIKE N'e2e-qc665%');
DELETE app.Hosts WHERE HostKey LIKE N'e2e-qc665%';

COMMIT TRANSACTION;
