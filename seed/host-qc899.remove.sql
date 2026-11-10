-- QC-899: removes everything the auth-cleanup cases (tests/35-auth-cleanup.spec.ts) leave in the host database:
--   * every e2e.qc899.* user (the seeded host admin from host-qc899-admin.apply.sql and the users AUTHCLEAN-06 creates
--     through the API) with roles, EULA signatures, claims, tokens, sessions, refresh tokens, sign-in history, access
--     logs, audit rows and the emails recorded for them in auth.SystemNotifications,
--   * every organisation named 'E2E QC-899 %' (AUTHCLEAN-05 creates and edits one through the API) with its locations,
--     addresses, customer and vendor settings, history and audit rows (also the audit rows the host admin's saves wrote).
-- Works with and without QC-899's schema. Run against the host database (LOCAL_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC899.%';

DECLARE @Organisations TABLE (Id int PRIMARY KEY);
INSERT @Organisations SELECT OrganisationID FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-899 %';

DECLARE @Locations TABLE (Id int PRIMARY KEY);
INSERT @Locations SELECT OrganisationLocationID FROM auth.OrganisationLocations WHERE OrganisationIdFk IN (SELECT Id FROM @Organisations);

DECLARE @Addresses TABLE (Id int PRIMARY KEY);
INSERT @Addresses SELECT DISTINCT AddressID_FK FROM app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations) AND AddressID_FK IS NOT NULL;

BEGIN TRANSACTION;

DELETE app.CustomerSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations) OR BillToUserId_Fk IN (SELECT Id FROM @Users);
DELETE app.VendorSettings WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE app.OrganisationAddresses WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE app.Addresses WHERE AddressID IN (SELECT Id FROM @Addresses);
DELETE app.OrganisationHistory WHERE OrganisationID_FK IN (SELECT Id FROM @Organisations);
DELETE auth.AuditChanges
WHERE KeyId IN (SELECT Id FROM @Users) OR UpdatedByUser IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc899.%'
   OR (AuditObject LIKE N'Organi%' AND (KeyId IN (SELECT CONVERT(nvarchar(20), Id) FROM @Organisations)
       OR KeyId IN (SELECT CONVERT(nvarchar(20), Id) FROM @Locations) OR Changes LIKE N'%E2E QC-899 %'));

DELETE auth.SystemNotifications WHERE NotifcationTo LIKE N'%e2e.qc899.%';
DELETE app.IdentitySessions WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE app.ThemeSettings WHERE UserID_FK IN (SELECT Id FROM @Users);
DELETE auth.AccessLogs WHERE UserId IN (SELECT Id FROM @Users);
DELETE auth.LoginHistories WHERE UserId IN (SELECT Id FROM @Users) OR UserName LIKE N'e2e.qc899.%';
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

DELETE auth.OrganisationLocations WHERE OrganisationIdFk IN (SELECT Id FROM @Organisations);
DELETE auth.Organisations WHERE OrganisationID IN (SELECT Id FROM @Organisations);

COMMIT TRANSACTION;
