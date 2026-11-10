-- QC-823 (moved to the auth tables by QC-901): makes the throwaway Identity user $(UserUuid) an active platform admin in HOST_MASTER
-- (an auth.Users row with the SuperAdmin role in auth.UserToRoles; app.PlatformAdmins on a HOST_MASTER without the
-- QC-901 auth tables), named $(DisplayName), which must start with "E2E QC-823".
-- Run against MASTER_SQL_DATABASE. The Admin API caches the admin list for a minute, so a new row can take that long to
-- count. master-qc823-platform-admin.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserUuid uniqueidentifier = N'$(UserUuid)';
DECLARE @DisplayName nvarchar(200) = N'$(DisplayName)';
DECLARE @UserId nvarchar(36) = LOWER(CONVERT(nvarchar(36), @UserUuid));

IF @DisplayName NOT LIKE N'E2E QC-823%'
    THROW 50001, 'The throwaway platform admin name must start with E2E QC-823.', 1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'auth.UserToRoles', N'U') IS NOT NULL
BEGIN
    DELETE r FROM auth.UserToRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.UserUUID = @UserUuid OR u.DisplayName = @DisplayName;
    DELETE auth.Users WHERE UserUUID = @UserUuid OR DisplayName = @DisplayName;
    INSERT auth.Users (Id, UserUUID, DisplayName, CreatedBy, UpdatedBy) VALUES (@UserId, @UserUuid, @DisplayName, N'e2e', N'e2e');
    INSERT auth.UserToRoles (UserId, RoleName, CreatedBy) VALUES (@UserId, N'SuperAdmin', N'e2e');
END
ELSE
BEGIN
    EXEC sp_executesql
        N'DELETE app.PlatformAdmins WHERE UserUUID = @UserUuid OR DisplayName = @DisplayName;
          INSERT app.PlatformAdmins (UserUUID, DisplayName, CreatedBy, UpdatedBy) VALUES (@UserUuid, @DisplayName, N''e2e'', N''e2e'');',
        N'@UserUuid uniqueidentifier, @DisplayName nvarchar(200)', @UserUuid, @DisplayName;
END

COMMIT TRANSACTION;
