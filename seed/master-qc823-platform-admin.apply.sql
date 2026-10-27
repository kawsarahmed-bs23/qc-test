-- QC-823: makes the throwaway Identity user $(UserUuid) an active platform admin in HOST_MASTER (app.PlatformAdmins), named
-- $(DisplayName), which must start with "E2E QC-823". Run against MASTER_SQL_DATABASE. The Admin API caches the admin list
-- for a minute, so a new row can take that long to count. master-qc823-platform-admin.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserUuid uniqueidentifier = N'$(UserUuid)';
DECLARE @DisplayName nvarchar(200) = N'$(DisplayName)';

IF @DisplayName NOT LIKE N'E2E QC-823%'
    THROW 50001, 'The throwaway platform admin name must start with E2E QC-823.', 1;

BEGIN TRANSACTION;

DELETE app.PlatformAdmins WHERE UserUUID = @UserUuid OR DisplayName = @DisplayName;
INSERT app.PlatformAdmins (UserUUID, DisplayName, CreatedBy, UpdatedBy) VALUES (@UserUuid, @DisplayName, N'e2e', N'e2e');

COMMIT TRANSACTION;
