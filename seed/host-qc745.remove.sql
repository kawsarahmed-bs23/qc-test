-- QC-745: removes the rows the host API's upsert (POST api/environment-setting) created for the throwaway template keys.
-- Run against LOCAL_SQL_DATABASE (the target host's database). Only group E2EQC745 is touched; no row that existed before the run.
SET NOCOUNT ON;

DELETE app.EnvironmentSetting WHERE GroupName LIKE 'E2EQC745%';
