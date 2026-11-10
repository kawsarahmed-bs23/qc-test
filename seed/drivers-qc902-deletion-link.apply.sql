-- QC-902 part 2: in DRIVERS_SQL_DATABASE (one-list schema 027-030 plus the deletion migrations 032-033), gives the throwaway
-- driver $(UserId) (the Identity sub of e2e.qc902.deletion@quarryconnect.test) one active link to the local host $(HostUuid),
-- marked as synced so the resync sweep leaves it alone. Its Driver account comes from drivers-qc902-account.apply.sql.
-- drivers-qc902-deletion.remove.sql deletes both.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverDeletions', N'U') IS NULL OR COL_LENGTH(N'app.DriverSettings', N'DeletionRequestedAt') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 deletion migrations (032-033).', 1;
IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50003, 'This DRIVERS database does not have the QC-902 one-list migrations (027-030).', 1;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');
DECLARE @HostUuid uniqueidentifier = (SELECT HostUUID FROM app.Hosts WHERE HostUUID = CONVERT(uniqueidentifier, N'$(HostUuid)') AND Active = 1);
IF @HostUuid IS NULL
    THROW 50002, 'The local host is not an active host in the drivers database.', 1;

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserUUID = @UserUuid;

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
VALUES (@UserUuid, @HostUuid, N'e2e-qc902', N'e2e-qc902', GETUTCDATE(), GETUTCDATE(), N'E2E QC-902 Deletion Driver');

COMMIT TRANSACTION;
