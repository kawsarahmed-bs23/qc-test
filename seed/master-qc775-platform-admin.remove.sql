-- QC-775 (moved to the auth tables by QC-901): removes the throwaway platform admins whose name is LIKE $(DisplayNameLike)
-- (always "E2E QC-775..."), added by master-qc775-platform-admin.apply.sql: their auth.Users rows and role links, and
-- any app.PlatformAdmins rows.
-- Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DisplayNameLike nvarchar(200) = N'$(DisplayNameLike)';

IF @DisplayNameLike NOT LIKE N'E2E QC-775%'
    THROW 50001, 'Only E2E QC-775 platform admins can be removed by this script.', 1;

BEGIN TRANSACTION;

IF OBJECT_ID(N'auth.UserToRoles', N'U') IS NOT NULL
BEGIN
    DELETE r FROM auth.UserToRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.DisplayName LIKE @DisplayNameLike AND u.DisplayName LIKE N'E2E QC-775%';
    DELETE auth.Users WHERE DisplayName LIKE @DisplayNameLike AND DisplayName LIKE N'E2E QC-775%';
END

IF OBJECT_ID(N'app.PlatformAdmins', N'U') IS NOT NULL
    EXEC sp_executesql N'DELETE app.PlatformAdmins WHERE DisplayName LIKE @DisplayNameLike AND DisplayName LIKE N''E2E QC-775%'';',
        N'@DisplayNameLike nvarchar(200)', @DisplayNameLike;

COMMIT TRANSACTION;
