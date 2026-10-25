-- QC-775: removes the throwaway platform admins whose name is LIKE $(DisplayNameLike) (always "E2E QC-775..."),
-- added by master-qc775-platform-admin.apply.sql. Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;

DECLARE @DisplayNameLike nvarchar(200) = N'$(DisplayNameLike)';

IF @DisplayNameLike NOT LIKE N'E2E QC-775%'
    THROW 50001, 'Only E2E QC-775 platform admins can be removed by this script.', 1;

DELETE app.PlatformAdmins WHERE DisplayName LIKE @DisplayNameLike AND DisplayName LIKE N'E2E QC-775%';
