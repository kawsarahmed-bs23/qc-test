-- QC-1008: removes the app.UserInvites rows host-qc1008.apply.sql adds (CreatedBy e2e-qc1008) and unlinks the e2e.qc913.*@example.com
-- host users it linked to an Identity login. Prints REMOVED invites=<n>;left=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Removed int = 0;

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
BEGIN
    DELETE app.UserInvites WHERE CreatedBy = N'e2e-qc1008' AND InvitedEmail LIKE N'e2e.qc913.%@example.com';
    SET @Removed = @@ROWCOUNT;
END;

UPDATE auth.Users SET UserUUID = NULL WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM' AND UserUUID IS NOT NULL;

COMMIT TRANSACTION;

DECLARE @Left int = 0;
IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    SET @Left = (SELECT COUNT(*) FROM app.UserInvites WHERE CreatedBy = N'e2e-qc1008');
PRINT CONCAT('REMOVED invites=', @Removed, ';left=', @Left);
