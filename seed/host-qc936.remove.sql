-- QC-936: removes what host-qc936.apply.sql and the "Text messages" cases (tests/app/notify-by-sms.spec.ts) left in the host
-- database:
--   * every e2e.qc936.*@quarryconnect.test user (the seeded ones and the e2e.qc936.created.* users the cases create through
--     Manage Users and the Vendor Portal) with their app.UserSettings rows, invites, roles, EULA signatures, audit rows,
--     sessions, refresh tokens, sign-in history and any driver-mirror rows a save made,
--   * the notifications sent to an e2e.qc936.* address and the EmailUserCreatedAudit rows whose body names one,
--   * the 'E2E QC-936 %' organisations with their VendorSettings / TruckSettings, locations and addresses.
-- Prints 'REMOVED left=<n>' with the number of e2e.qc936 users, their app.UserSettings rows and the QC-936 organisations still
-- there (0 when clean).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC936.%@QUARRYCONNECT.TEST' OR NormalizedUserName LIKE N'E2E.QC936.%@QUARRYCONNECT.TEST';

DECLARE @Orgs TABLE (Id int PRIMARY KEY);
INSERT @Orgs SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-936 %';

DECLARE @OrgAddresses TABLE (Id int PRIMARY KEY);
INSERT @OrgAddresses SELECT DISTINCT AddressID_FK FROM app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);

BEGIN TRANSACTION;

DELETE app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users);

IF OBJECT_ID(N'app.UserInvites', N'U') IS NOT NULL
    DELETE app.UserInvites WHERE UserID_FK IN (SELECT Id FROM @Users) OR InvitedEmail LIKE N'e2e.qc936.%@quarryconnect.test';

DELETE auth.SystemNotifications
WHERE NotifcationTo LIKE N'%e2e.qc936.%@quarryconnect.test%'
   OR (MessageTypeName = N'EmailUserCreatedAudit' AND MessageBody LIKE N'%e2e.qc936.%@quarryconnect.test%');

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Users);

IF OBJECT_ID(N'auth.AuditChanges', N'U') IS NOT NULL
    DELETE auth.AuditChanges WHERE KeyId IN (SELECT Id FROM @Users);
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc936.%@quarryconnect.test';
IF OBJECT_ID(N'auth.PasswordHistories', N'U') IS NOT NULL
    DELETE auth.PasswordHistories WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
IF OBJECT_ID(N'auth.UserLogins', N'U') IS NOT NULL
    DELETE auth.UserLogins WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
UPDATE app.VendorSettings SET DispatchContactUserID_FK = NULL WHERE DispatchContactUserID_FK IN (SELECT Id FROM @Users);
UPDATE app.VendorSettings SET BillToUserId_Fk = NULL WHERE BillToUserId_Fk IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE app.Addresses WHERE AddressID IN (SELECT Id FROM @OrgAddresses)
  AND NOT EXISTS (SELECT 1 FROM app.OrganisationAddresses oa WHERE oa.AddressID_FK = app.Addresses.AddressID)
  AND NOT EXISTS (SELECT 1 FROM app.JobAddresses ja WHERE ja.AddressID_FK = app.Addresses.AddressID);
DELETE auth.OrganisationLocations WHERE OrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE app.TruckSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE app.VendorSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs) AND ParentOrganisationIdFk IN (SELECT Id FROM @Orgs);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Orgs);

COMMIT TRANSACTION;

SELECT CONCAT('REMOVED left=',
    (SELECT COUNT(*) FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC936.%@QUARRYCONNECT.TEST' OR NormalizedUserName LIKE N'E2E.QC936.%@QUARRYCONNECT.TEST')
  + (SELECT COUNT(*) FROM app.UserSettings WHERE UserID_FK IN (SELECT Id FROM @Users))
  + (SELECT COUNT(*) FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-936 %'));
