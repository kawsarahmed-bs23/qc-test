-- QC-774: removes what host-qc774-vendor.apply.sql and the driver-invite cases left in the host database:
--   * every app.DriverInvites row of the 'E2E QC-774 Vendor' organisation, and any invite sent to an e2e.qc774.* email,
--   * every e2e.qc774.*@quarryconnect.test user: the vendor, and the driver users LinkEstablished created (Id = the driver's
--     Identity sub, role Driver, organisation = the invite's truck), with their roles, EULA signatures, sessions, refresh
--     tokens, login history and the driver-mirror subscription and change rows the link's resync request made,
--   * the mirror subscription and change rows of the drivers in $(UserIds) (comma-separated Identity subs, or none) that
--     never got a host user (DINV-09: a link the host refused still sends DriverResyncRequested),
--   * the two 'E2E QC-774 Truck' organisations and the vendor organisation.
-- The mirror subscription goes first, so the QC-825 triggers write no change rows while the rest is deleted.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC774.%@QUARRYCONNECT.TEST';

DECLARE @Subs TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Subs SELECT Id FROM @Users;
INSERT @Subs SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',')
WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none') AND LTRIM(RTRIM(value)) NOT IN (SELECT Id FROM @Users);

DECLARE @Vendors TABLE (Id int PRIMARY KEY);
INSERT @Vendors SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName = N'E2E QC-774 Vendor' AND UpdatedBy = 'e2e-qc774';

DECLARE @Trucks TABLE (Id int PRIMARY KEY);
INSERT @Trucks SELECT OrganisationID FROM auth.Organisations
WHERE ParentOrganisationIdFk IN (SELECT Id FROM @Vendors) AND OrganisationName LIKE N'E2E QC-774 Truck%' AND UpdatedBy = 'e2e-qc774';

BEGIN TRANSACTION;

DELETE app.DriverInvites WHERE VendorID_FK IN (SELECT Id FROM @Vendors) OR TruckID_FK IN (SELECT Id FROM @Trucks)
    OR InvitedEmail LIKE N'e2e.qc774.%@quarryconnect.test';

IF OBJECT_ID(N'app.DriverMirrorSubscriptions', N'U') IS NOT NULL
    DELETE app.DriverMirrorSubscriptions WHERE UserID_FK IN (SELECT Id FROM @Subs);
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
    DELETE app.DriverMirrorChanges WHERE UserID_FK IN (SELECT Id FROM @Subs);
IF OBJECT_ID(N'app.DriverCommandReceipts', N'U') IS NOT NULL
    DELETE app.DriverCommandReceipts WHERE UserID_FK IN (SELECT Id FROM @Subs);
IF OBJECT_ID(N'app.DriverSyncTombstones', N'U') IS NOT NULL
    EXEC (N'DELETE app.DriverSyncTombstones WHERE DriverUserID_FK IN (SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N''E2E.QC774.%@QUARRYCONNECT.TEST'')');

DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc774.%@quarryconnect.test';
DELETE auth.PasswordHistories WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.RefreshTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserLogins WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserTokens WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.Users WHERE Id IN (SELECT Id FROM @Users);

DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Trucks);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Vendors);

COMMIT TRANSACTION;
