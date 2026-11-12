-- QC-913: removes what tests/app/user-invites.spec.ts left in the host database:
--   * every e2e.qc913.*@example.com host user (the users the cases create through Manage Users and the Vendor Portal, and the
--     seeded vendor), with their app.UserInvites rows, roles, EULA signatures, audit rows, sessions, refresh tokens, sign-in
--     history and any driver-mirror rows an accepted Driver invite made,
--   * every app.UserInvites row sent to an e2e.qc913.* address (also the ones left after an email change),
--   * the auth.SystemNotifications rows of the emails sent to e2e.qc913.* addresses, and the EmailUserCreatedAudit rows
--     (sent to EmailSettings:RecipientEmails) whose body names one of them,
--   * the two 'E2E QC-913 Truck' organisations and the 'E2E QC-913 Vendor' organisation.
-- Prints REMOVED users=<n>;invites=<n>;notifications=<n>;left=<n>;leftInvites=<n>;leftNotifications=<n>;leftOrganisations=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM' OR NormalizedUserName LIKE N'E2E.QC913.%@EXAMPLE.COM';

DECLARE @Vendors TABLE (Id int PRIMARY KEY);
INSERT @Vendors SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E QC-913 Vendor' AND UpdatedBy = 'e2e-qc913';

DECLARE @Trucks TABLE (Id int PRIMARY KEY);
INSERT @Trucks SELECT OrganisationID FROM auth.Organisations
WHERE ParentOrganisationIdFk IN (SELECT Id FROM @Vendors) AND OrganisationName LIKE N'E2E QC-913 Truck%' AND UpdatedBy = 'e2e-qc913';

DECLARE @UserCount int = (SELECT COUNT(*) FROM @Users);
DECLARE @InviteCount int = 0;
DECLARE @NotificationCount int;

BEGIN TRANSACTION;

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
BEGIN
    DELETE app.UserInvites WHERE UserID_FK IN (SELECT Id FROM @Users) OR InvitedEmail LIKE N'e2e.qc913.%@example.com';
    SET @InviteCount = @@ROWCOUNT;
END

DELETE auth.SystemNotifications
WHERE NotifcationTo LIKE N'%e2e.qc913.%@example.com%'
   OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.qc913.%@example.com%');
SET @NotificationCount = @@ROWCOUNT;

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.UserSettings', N'U') IS NOT NULL
    DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);

DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc913.%@example.com';
IF OBJECT_ID(N'auth.PasswordHistories', N'U') IS NOT NULL
    DELETE auth.PasswordHistories WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.UserLogins', N'U') IS NOT NULL
    DELETE auth.UserLogins WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Trucks);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Vendors);

COMMIT TRANSACTION;

DECLARE @Left int = (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM' OR NormalizedUserName LIKE N'E2E.QC913.%@EXAMPLE.COM');
DECLARE @LeftInvites int = 0;
IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    SET @LeftInvites = (SELECT COUNT(*) FROM app.UserInvites WHERE InvitedEmail LIKE N'e2e.qc913.%@example.com');
DECLARE @LeftNotifications int = (
    SELECT COUNT(*) FROM auth.SystemNotifications
    WHERE NotifcationTo LIKE N'%e2e.qc913.%@example.com%'
       OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.qc913.%@example.com%'));
DECLARE @LeftOrganisations int = (SELECT COUNT(*) FROM auth.Organisations WHERE UpdatedBy = 'e2e-qc913');
PRINT CONCAT('REMOVED users=', @UserCount, ';invites=', @InviteCount, ';notifications=', @NotificationCount, ';left=', @Left,
    ';leftInvites=', @LeftInvites, ';leftNotifications=', @LeftNotifications, ';leftOrganisations=', @LeftOrganisations);
