-- QC-823 (moved to the auth tables by QC-901): removes every platform admin named "E2E QC-823..." from HOST_MASTER
-- (auth.Users and their auth.UserToRoles links,
-- and app.PlatformAdmins rows on a HOST_MASTER without the QC-901 tables): the rows made by master-qc823-platform-admin.apply.sql and the rows the
-- Admins page creates when a test adds an e2e.qc823.* user (Admin names them "E2E <last name>", and those users' last
-- names start with QC-823). Run against MASTER_SQL_DATABASE.
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

IF OBJECT_ID(N'auth.UserToRoles', N'U') IS NOT NULL
BEGIN
    DELETE r FROM auth.UserToRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.DisplayName LIKE N'E2E QC-823%';
    DELETE auth.Users WHERE DisplayName LIKE N'E2E QC-823%';
END

IF OBJECT_ID(N'app.PlatformAdmins', N'U') IS NOT NULL
    EXEC (N'DELETE app.PlatformAdmins WHERE DisplayName LIKE N''E2E QC-823%'';');

COMMIT TRANSACTION;
