-- QC-913 / QC-915: deletes the test invite signing keys from HOST_MASTER app.HostInviteSigningKeys, whether
-- master-qc913-invite-key.apply.sql registered them or a test added them through the Admin Sign-in page (and then retired
-- them, which only sets Active = 0): every row whose kid starts with qc914-local- or e2e-qc913-. The hosts' own keys
-- (any other kid, such as qc913-local-1) are left alone. Prints REMOVED keys=<n>;left=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Removed int = 0;
IF OBJECT_ID(N'app.HostInviteSigningKeys', N'U') IS NOT NULL
BEGIN
    DELETE app.HostInviteSigningKeys WHERE Kid LIKE N'qc914-local-%' OR Kid LIKE N'e2e-qc913-%';
    SET @Removed = @@ROWCOUNT;
END

DECLARE @Left int = 0;
IF OBJECT_ID(N'app.HostInviteSigningKeys', N'U') IS NOT NULL
    SET @Left = (SELECT COUNT(*) FROM app.HostInviteSigningKeys WHERE Kid LIKE N'qc914-local-%' OR Kid LIKE N'e2e-qc913-%');
PRINT CONCAT('REMOVED keys=', @Removed, ';left=', @Left);
