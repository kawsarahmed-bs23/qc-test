-- QC-801: deletes the host role SuperAdmin again after superadmin-role-qc801.apply.sql, so the local database ends with
-- no SuperAdmin row in auth.UserToRoles, auth.RolesToPermissions, auth.RoleClaims or auth.Roles (the state
-- remove_host_superadmin_role.sql leaves; QC-899 drops auth.RoleClaims, so it is skipped when absent). Only the throwaway e2e users' SuperAdmin rows are deleted; if anyone else holds
-- the role it stops without changes. Run against the host database after the user remove scripts.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @RoleName nvarchar(100) = N'SuperAdmin';

IF EXISTS (
    SELECT 1 FROM auth.UserToRoles ur JOIN auth.Users u ON u.Id = ur.UserId
    WHERE ur.RoleName = @RoleName AND u.NormalizedEmail NOT LIKE N'E2E.QC801.%@QUARRYCONNECT.TEST' AND u.NormalizedEmail NOT LIKE N'E2E.QC744.%@QUARRYCONNECT.TEST')
    THROW 50001, 'A user other than the e2e throwaways holds SuperAdmin; it was not seeded by the tests, so nothing is removed.', 1;

BEGIN TRANSACTION;

DELETE auth.UserToRoles WHERE RoleName = @RoleName;
IF OBJECT_ID(N'auth.RoleClaims', N'U') IS NOT NULL
    DELETE rc FROM auth.RoleClaims rc JOIN auth.Roles r ON r.Id = rc.RoleId WHERE r.Name = @RoleName;
DELETE auth.Roles WHERE Name = @RoleName;
DELETE auth.RolesToPermissions WHERE RoleName = @RoleName;

COMMIT TRANSACTION;
