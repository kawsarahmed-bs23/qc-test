-- QC-775: removes the probe feature e2e_qc775_probe that HF-09 pushes to the host database through Admin.
-- Run against LOCAL_SQL_DATABASE (the host API's database).
SET NOCOUNT ON;

DELETE app.HostFeatures WHERE FeatureKey = 'e2e_qc775_probe';
