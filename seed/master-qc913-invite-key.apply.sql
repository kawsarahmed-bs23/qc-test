-- QC-913 / QC-915: registers the public half of a test invite signing key in HOST_MASTER app.HostInviteSigningKeys for the
-- host whose ClientID is $(ClientId), so Identity accepts invite links the tests sign with the private half (INV-* in
-- tests/identity/invite-page.spec.ts signs with INVITE_TEST_HOST_PRIVATE_JWK). Only kids that start with qc914-local- or
-- e2e-qc913- are accepted; the host's own keys are never touched. Re-running reactivates the row.
-- master-qc913-invite-keys.remove.sql deletes these rows again.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Kid nvarchar(100) = N'$(Kid)';
IF @Kid NOT LIKE N'qc914-local-%' AND @Kid NOT LIKE N'e2e-qc913-%'
    THROW 50001, 'Only test kids (qc914-local-*, e2e-qc913-*) can be registered by this script.', 1;
IF OBJECT_ID(N'app.HostInviteSigningKeys', N'U') IS NULL
    THROW 50002, 'HOST_MASTER has no app.HostInviteSigningKeys table (QC-915 migration 202611111300).', 1;

DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE ClientID = N'$(ClientId)');
IF @HostId IS NULL
    THROW 50003, 'No HOST_MASTER host has that ClientID.', 1;

BEGIN TRANSACTION;

DELETE app.HostInviteSigningKeys WHERE HostID_FK = @HostId AND Kid = @Kid;
INSERT app.HostInviteSigningKeys (HostInviteSigningKeyUUID, HostID_FK, Kid, Kty, Crv, X, Y, Created, Updated, Active, CreatedBy, UpdatedBy)
VALUES (NEWID(), @HostId, @Kid, N'EC', N'P-256', N'$(X)', N'$(Y)', GETUTCDATE(), GETUTCDATE(), 1, N'e2e-qc913', N'e2e-qc913');

COMMIT TRANSACTION;
