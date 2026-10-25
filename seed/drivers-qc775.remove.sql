-- QC-775: removes the driver-host links made by drivers-qc775-link.apply.sql for the users in $(UserIds)
-- (a comma-separated list of Identity subs). Run against DRIVERS_SQL_DATABASE.
SET NOCOUNT ON;

DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N','));
