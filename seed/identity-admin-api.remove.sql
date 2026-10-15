-- QC-738: removes what the IDADMIN tests create through Identity's administration API, which has no delete:
-- the e2e-qc738 host with its branding, features and host clients, and every client whose id starts with e2e-qc738.
-- The IdentityServer client's URIs, scopes and grant types go with it (cascade).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @HostKey nvarchar(100) = N'e2e-qc738';

BEGIN TRANSACTION;

DELETE Clients WHERE ClientId LIKE N'e2e-qc738.%';
DELETE app.HostClients WHERE ClientID LIKE N'e2e-qc738.%' OR HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey = @HostKey);
DELETE app.HostBrandings WHERE HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey = @HostKey);
DELETE app.HostFeatures WHERE HostID IN (SELECT HostID FROM app.Hosts WHERE HostKey = @HostKey);
DELETE app.Hosts WHERE HostKey = @HostKey;

COMMIT TRANSACTION;
