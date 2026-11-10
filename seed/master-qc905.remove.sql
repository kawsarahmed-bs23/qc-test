-- QC-905: removes the HOST_MASTER change log rows the Admin email change cases (EMLCHG-*) write: requests and cancels for
-- e2e.qc905.*@quarryconnect.test users. Run against HOST_MASTER (MASTER_SQL_DATABASE).
SET NOCOUNT ON;

DELETE app.ChangeLogs
WHERE Area = N'Users'
  AND (Summary LIKE N'Requested a login email change from e2e.qc905.%' OR Summary LIKE N'Canceled the login email change for e2e.qc905.%');
