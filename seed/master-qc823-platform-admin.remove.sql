-- QC-823: removes every platform admin row named "E2E QC-823..." from HOST_MASTER (app.PlatformAdmins): the rows made by
-- master-qc823-platform-admin.apply.sql and the rows the Admins page creates when a test adds an e2e.qc823.* user
-- (Admin names them "E2E <last name>", and those users' last names start with QC-823). Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;

DELETE app.PlatformAdmins WHERE DisplayName LIKE N'E2E QC-823%';
