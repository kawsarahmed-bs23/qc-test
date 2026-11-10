-- QC-829: in DRIVERS_SQL_DATABASE, links the throwaway driver $(UserId) to
--   * the local host $(HostUuid) with SyncRequestedAt NULL, so the Drivers API's resync sweep asks that host for the
--     driver's work, and
--   * a second, throwaway host row $(SecondHostUuid) ('E2E QC-829 Second host', dispatch on).
-- The second driver of SYNC-05 gets no link: the move only has to take the job away from the first driver.
-- QC-902 one list (DRIVERS migrations 027-030, keyed by UserUUID / DriverUserUUID / HostUUID, hosts named in HostName):
-- the second host gets a message endpoint nothing listens on (tcp://localhost:6299), so driver writes on its rows are accepted
-- and queued in the Drivers API outbox, and two of the driver's jobs for today in that host's time zone:
-- 'e2e-qc829 second accepted' (Accepted) and 'e2e-qc829 second pending' (Pending). An older DRIVERS database
-- (UserID_FK / HostID_FK / Name) gets the two links and the empty second host, as before.
-- drivers-qc829.remove.sql deletes the links, every mirror row, command, tombstone and device of the driver, and the second host.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
DECLARE @SecondHostUuid uniqueidentifier = N'$(SecondHostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql N'
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE N''Central Standard Time'' AS date);

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserUUID = @UserId;

INSERT app.Hosts (HostUUID, HostName, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (@SecondHostUuid, N''E2E QC-829 Second host'', N''https://localhost:7999/'', N''drivers.service.e2e-qc829'', GETUTCDATE(), GETUTCDATE(), 1, N''e2e'', N''e2e'', N''tcp://localhost:6299'', 1, N''Central Standard Time'');

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy) VALUES (@UserId, @HostUuid, N''e2e'', N''e2e''), (@UserId, @SecondHostUuid, N''e2e'', N''e2e'');

INSERT app.OrderAssignments
    (HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
     JobDocNameWithPrefix, Origin, Destination, MaterialName, CanUploadTickets, CreatedBy, UpdatedBy, HostName, VendorName, TruckName)
VALUES
    (@SecondHostUuid, @UserId, NEWID(), 1, @Today, 2, 2, 10, N''e2e-qc829 second accepted'',
     N''E2E-QC829-H2-A'', N''E2E QC-829 Quarry 2'', N''E2E QC-829 Site 2'', N''E2E Gravel'', 0, N''e2e'', N''e2e'', N''E2E QC-829 Second host (as hauled)'', N''E2E Vendor 2'', N''E2E Truck 2''),
    (@SecondHostUuid, @UserId, NEWID(), 1, @Today, 1, 2, 10, N''e2e-qc829 second pending'',
     N''E2E-QC829-H2-P'', N''E2E QC-829 Quarry 2'', N''E2E QC-829 Site 2'', N''E2E Gravel'', 0, N''e2e'', N''e2e'', N''E2E QC-829 Second host (as hauled)'', N''E2E Vendor 2'', N''E2E Truck 2'');

COMMIT TRANSACTION;', N'@UserId nvarchar(450), @HostUuid uniqueidentifier, @SecondHostUuid uniqueidentifier', @UserId, @HostUuid, @SecondHostUuid;
ELSE
    EXEC sp_executesql N'
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1);

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserID_FK = @UserId;

INSERT app.Hosts (HostUUID, Name, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (@SecondHostUuid, N''E2E QC-829 Second host'', N''https://localhost:7999/'', N''drivers.service.e2e-qc829'', GETUTCDATE(), GETUTCDATE(), 1, N''e2e'', N''e2e'', NULL, 1, N''Central Standard Time'');
DECLARE @SecondHostId int = SCOPE_IDENTITY();

INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N''e2e'', N''e2e'');
INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @SecondHostId, N''e2e'', N''e2e'');

COMMIT TRANSACTION;', N'@UserId nvarchar(450), @HostUuid uniqueidentifier, @SecondHostUuid uniqueidentifier', @UserId, @HostUuid, @SecondHostUuid;
