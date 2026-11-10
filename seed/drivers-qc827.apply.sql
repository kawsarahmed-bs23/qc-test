-- QC-827: links the throwaway driver $(UserId) (e2e.qc827.driver) to the local host $(HostUuid) in DRIVERS_SQL_DATABASE, so the
-- host's JobOffered / JobRatesChanged events for it are stored and the Drivers API shows its assignments
-- (tests/39-bill-rates.spec.ts). Needs a DRIVERS database with migration 040 (app.AssignmentRates).
-- drivers-qc827.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId uniqueidentifier = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;
IF OBJECT_ID(N'app.AssignmentRates', N'U') IS NULL OR COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50002, 'The drivers database has no app.AssignmentRates (migration 040) or is not on the one-list schema (027-030).', 1;

DELETE app.DriverHostLinks WHERE UserUUID = @UserId AND HostUUID = @HostUuid;
INSERT app.DriverHostLinks (UserUUID, HostUUID, DriverName, CreatedBy, UpdatedBy) VALUES (@UserId, @HostUuid, N'E2E QC-827 Driver', N'e2e-qc827', N'e2e-qc827');
