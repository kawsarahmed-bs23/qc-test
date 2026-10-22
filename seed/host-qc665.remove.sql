-- QC-665: removes the host-database driver row added by host-qc665-driver.apply.sql. Run against the host database.
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC665.%@QUARRYCONNECT.TEST');
DELETE auth.Users WHERE NormalizedEmail LIKE N'E2E.QC665.%@QUARRYCONNECT.TEST';

COMMIT TRANSACTION;
