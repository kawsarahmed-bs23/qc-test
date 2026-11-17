-- QC-983: removes what host-qc983.apply.sql seeded (and any e2e.qc983.* user a case created) from the host database:
-- the e2e.qc983.*@example.com users with their invites, roles and audit rows, and the 'E2E QC-983' truck, vendor and customer.
-- Prints REMOVED users=<n>;left=<n>;leftInvites=<n>;leftOrganisations=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC983.%@EXAMPLE.COM' OR NormalizedUserName LIKE N'E2E.QC983.%@EXAMPLE.COM';
DECLARE @UserCount int = (SELECT COUNT(*) FROM @Users);

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    EXEC(N'DELETE app.UserInvites WHERE UserID_FK IN (SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N''E2E.QC983.%@EXAMPLE.COM'') OR InvitedEmail LIKE N''e2e.qc983.%@example.com''');

DELETE auth.SystemNotifications WHERE NotifcationTo LIKE N'%e2e.qc983.%@example.com%';
DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.UserSettings', N'U') IS NOT NULL
    DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE auth.Organisations WHERE UpdatedBy = 'e2e-qc983' AND OrganisationName = N'E2E QC-983 Truck';
DELETE auth.Organisations WHERE UpdatedBy = 'e2e-qc983' AND OrganisationName IN (N'E2E QC-983 Vendor', N'E2E QC-983 Customer');

COMMIT TRANSACTION;

DECLARE @Left int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC983.%@EXAMPLE.COM');
DECLARE @LeftInvites int = 0;
IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    EXEC sp_executesql N'SELECT @n = COUNT(*) FROM app.UserInvites WHERE InvitedEmail LIKE N''e2e.qc983.%@example.com''', N'@n int OUTPUT', @n = @LeftInvites OUTPUT;
DECLARE @LeftOrganisations int = (SELECT COUNT(*) FROM auth.Organisations WHERE UpdatedBy = 'e2e-qc983');
PRINT CONCAT('REMOVED users=', @UserCount, ';left=', @Left, ';leftInvites=', @LeftInvites, ';leftOrganisations=', @LeftOrganisations);
