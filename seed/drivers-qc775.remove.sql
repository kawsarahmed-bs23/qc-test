-- QC-775: removes the driver-host links made by drivers-qc775-link.apply.sql for the users in $(UserIds)
-- (a comma-separated list of Identity subs). Run against DRIVERS_SQL_DATABASE.
-- QC-902 one list: UserUUID since DRIVERS migration 027, UserID_FK before.
SET NOCOUNT ON;

DECLARE @UserIds nvarchar(max) = N'$(UserIds)';

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql
        N'DELETE app.DriverHostLinks WHERE UserUUID IN (SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(@UserIds, N'',''));',
        N'@UserIds nvarchar(max)', @UserIds;
ELSE
    EXEC sp_executesql
        N'DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(@UserIds, N'',''));',
        N'@UserIds nvarchar(max)', @UserIds;
