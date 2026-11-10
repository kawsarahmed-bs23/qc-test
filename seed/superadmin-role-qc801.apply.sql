-- QC-801: puts the host role SuperAdmin back for a test, so a throwaway user can hold a SuperAdmin row again (ROOT-04,
-- REC-08). The rows are taken from app.QC801_SuperAdminBackup, the copy remove_host_superadmin_role.sql made before it
-- deleted them (auth.RolesToPermissions and auth.Roles; no user's SuperAdmin row is put back). Without that backup a
-- minimal row is used (QC-899 drops the backup and auth.Roles.Discriminator; the minimal row works with or without them).
-- Does nothing if the role is still there. superadmin-role-qc801.remove.sql deletes it again; the
-- local database must end every run with no SuperAdmin rows. Run against the host database (LOCAL_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @RoleName nvarchar(100) = N'SuperAdmin';
DECLARE @HasBackup bit = CASE WHEN OBJECT_ID(N'app.QC801_SuperAdminBackup', N'U') IS NULL THEN 0 ELSE 1 END;
DECLARE @BackupRolesToPermissions bit = 0;
DECLARE @BackupRoles bit = 0;
IF @HasBackup = 1
    EXEC sp_executesql N'
        SELECT @rtp = CASE WHEN EXISTS (SELECT 1 FROM app.QC801_SuperAdminBackup WHERE Kind = ''RolesToPermissions'') THEN 1 ELSE 0 END,
               @roles = CASE WHEN EXISTS (SELECT 1 FROM app.QC801_SuperAdminBackup WHERE Kind = ''Roles'') THEN 1 ELSE 0 END;',
        N'@rtp bit OUTPUT, @roles bit OUTPUT', @rtp = @BackupRolesToPermissions OUTPUT, @roles = @BackupRoles OUTPUT;

BEGIN TRANSACTION;

IF NOT EXISTS (SELECT 1 FROM auth.RolesToPermissions WHERE RoleName = @RoleName)
BEGIN
    IF @BackupRolesToPermissions = 1
        EXEC sp_executesql N'
            INSERT auth.RolesToPermissions (RoleName, Description, PermissionsInRole)
            SELECT TOP 1 j.RoleName, j.Description, j.PermissionsInRole
            FROM app.QC801_SuperAdminBackup b
            CROSS APPLY OPENJSON(b.Payload) WITH (RoleName nvarchar(100), Description nvarchar(max), PermissionsInRole nvarchar(max)) j
            WHERE b.Kind = ''RolesToPermissions'' ORDER BY b.BackupId DESC;';
    ELSE
        INSERT auth.RolesToPermissions (RoleName, Description, PermissionsInRole) VALUES (@RoleName, N'SuperAdmin Role', N'');
END

IF NOT EXISTS (SELECT 1 FROM auth.Roles WHERE Name = @RoleName)
BEGIN
    IF @BackupRoles = 1
        EXEC sp_executesql N'
            INSERT auth.Roles (Id, Name, NormalizedName, ConcurrencyStamp, Discriminator, RoleType, RoleParentId, HomePage, ReportClassIdFk)
            SELECT TOP 1 j.Id, j.Name, j.NormalizedName, j.ConcurrencyStamp, j.Discriminator, j.RoleType, j.RoleParentId, j.HomePage, j.ReportClassIdFk
            FROM app.QC801_SuperAdminBackup b
            CROSS APPLY OPENJSON(b.Payload) WITH (Id nvarchar(450), Name nvarchar(256), NormalizedName nvarchar(256), ConcurrencyStamp nvarchar(max),
                Discriminator nvarchar(max), RoleType nvarchar(max), RoleParentId nvarchar(max), HomePage nvarchar(max), ReportClassIdFk varchar(100)) j
            WHERE b.Kind = ''Roles'' ORDER BY b.BackupId DESC;';
    ELSE IF COL_LENGTH(N'auth.Roles', N'Discriminator') IS NOT NULL
        EXEC sp_executesql N'
            INSERT auth.Roles (Id, Name, NormalizedName, Discriminator, RoleType)
            VALUES (LOWER(CONVERT(nvarchar(36), NEWID())), @RoleName, UPPER(@RoleName), N''Roles'', N''Administration'');',
            N'@RoleName nvarchar(100)', @RoleName = @RoleName;
    ELSE
        INSERT auth.Roles (Id, Name, NormalizedName, RoleType)
        VALUES (LOWER(CONVERT(nvarchar(36), NEWID())), @RoleName, UPPER(@RoleName), N'Administration');
END

COMMIT TRANSACTION;
