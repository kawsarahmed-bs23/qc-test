-- QC-825: in DRIVERS_SQL_DATABASE, links the throwaway driver $(UserId) to
--   * the local host $(HostUuid) with SyncRequestedAt NULL, so the Drivers API's resync sweep asks that host for the
--     driver's work (AC8), and
--   * a second, throwaway host row $(SecondHostUuid) ('E2E QC-825 Second host', dispatch on) (AC2).
-- QC-902 one list (DRIVERS migrations 027-030, keyed by UserUUID / DriverUserUUID / HostUUID, hosts named in HostName):
--   * the second host gets a message endpoint nothing listens on (tcp://localhost:6299), so driver writes on its rows are
--     accepted and queued in the Drivers API outbox, and two of the driver's jobs for today in that host's time zone:
--     'e2e-qc825 second pending' (Pending) and 'e2e-qc825 second accepted' (Accepted), as hauled for 'E2E QC-825 Second host (as hauled)';
--   * a third throwaway host $(OffHostUuid) ('E2E QC-825 Off host', dispatch off) with one linked job 'e2e-qc825 off'.
-- An older DRIVERS database (UserID_FK / HostID_FK / Name) gets only the two links and the empty second host, as before.
-- drivers-qc825.remove.sql deletes the links, every mirror row and command of the driver, and every 'E2E QC-825%' host.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
DECLARE @SecondHostUuid uniqueidentifier = N'$(SecondHostUuid)';
DECLARE @OffHostUuid uniqueidentifier = N'$(OffHostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The local host is not an active host in the drivers database.', 1;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql N'
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE N''Central Standard Time'' AS date);

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserUUID = @UserId;

DECLARE @HostsInsert nvarchar(max) = CASE WHEN COL_LENGTH(N''app.Hosts'', N''ApiBaseUrl'') IS NULL
    THEN N''INSERT app.Hosts (HostUUID, HostName, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (@SecondHostUuid, N''''E2E QC-825 Second host'''', GETUTCDATE(), GETUTCDATE(), 1, N''''e2e'''', N''''e2e'''', N''''tcp://localhost:6299'''', 1, N''''Central Standard Time''''),
       (@OffHostUuid, N''''E2E QC-825 Off host'''', GETUTCDATE(), GETUTCDATE(), 1, N''''e2e'''', N''''e2e'''', N''''tcp://localhost:6299'''', 0, N''''Central Standard Time'''');''
    ELSE N''INSERT app.Hosts (HostUUID, HostName, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (@SecondHostUuid, N''''E2E QC-825 Second host'''', N''''https://localhost:7999/'''', N''''drivers.service.e2e-qc825'''', GETUTCDATE(), GETUTCDATE(), 1, N''''e2e'''', N''''e2e'''', N''''tcp://localhost:6299'''', 1, N''''Central Standard Time''''),
       (@OffHostUuid, N''''E2E QC-825 Off host'''', N''''https://localhost:7998/'''', N''''drivers.service.e2e-qc825-off'''', GETUTCDATE(), GETUTCDATE(), 1, N''''e2e'''', N''''e2e'''', N''''tcp://localhost:6299'''', 0, N''''Central Standard Time'''');'' END;
EXEC sp_executesql @HostsInsert, N''@SecondHostUuid uniqueidentifier, @OffHostUuid uniqueidentifier'', @SecondHostUuid, @OffHostUuid;

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy) VALUES (@UserId, @HostUuid, N''e2e'', N''e2e''), (@UserId, @SecondHostUuid, N''e2e'', N''e2e''), (@UserId, @OffHostUuid, N''e2e'', N''e2e'');

INSERT app.OrderAssignments
    (HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
     JobDocNameWithPrefix, Origin, Destination, MaterialName, CanUploadTickets, CreatedBy, UpdatedBy, HostName, VendorName, TruckName)
VALUES
    (@SecondHostUuid, @UserId, NEWID(), 1, @Today, 1, 2, 10, N''e2e-qc825 second pending'',
     N''E2E-QC825-H2-P'', N''E2E QC-825 Quarry 2'', N''E2E QC-825 Site 2'', N''E2E Gravel'', 0, N''e2e'', N''e2e'', N''E2E QC-825 Second host (as hauled)'', N''E2E Vendor 2'', N''E2E Truck 2''),
    (@SecondHostUuid, @UserId, NEWID(), 1, @Today, 2, 2, 10, N''e2e-qc825 second accepted'',
     N''E2E-QC825-H2-A'', N''E2E QC-825 Quarry 2'', N''E2E QC-825 Site 2'', N''E2E Gravel'', 0, N''e2e'', N''e2e'', N''E2E QC-825 Second host (as hauled)'', N''E2E Vendor 2'', N''E2E Truck 2''),
    (@OffHostUuid, @UserId, NEWID(), 1, @Today, 2, 2, 10, N''e2e-qc825 off'',
     N''E2E-QC825-OFF'', N''E2E QC-825 Quarry 3'', N''E2E QC-825 Site 3'', N''E2E Gravel'', 0, N''e2e'', N''e2e'', N''E2E QC-825 Off host'', N''E2E Vendor 3'', N''E2E Truck 3'');

COMMIT TRANSACTION;', N'@UserId nvarchar(450), @HostUuid uniqueidentifier, @SecondHostUuid uniqueidentifier, @OffHostUuid uniqueidentifier',
        @UserId, @HostUuid, @SecondHostUuid, @OffHostUuid;
ELSE
    EXEC sp_executesql N'
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1);

BEGIN TRANSACTION;

DELETE app.DriverHostLinks WHERE UserID_FK = @UserId;

INSERT app.Hosts (HostUUID, Name, ApiBaseUrl, ClientId, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES (@SecondHostUuid, N''E2E QC-825 Second host'', N''https://localhost:7999/'', N''drivers.service.e2e-qc825'', GETUTCDATE(), GETUTCDATE(), 1, N''e2e'', N''e2e'', NULL, 1, N''Central Standard Time'');
DECLARE @SecondHostId int = SCOPE_IDENTITY();

INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @HostId, N''e2e'', N''e2e'');
INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy) VALUES (@UserId, @SecondHostId, N''e2e'', N''e2e'');

COMMIT TRANSACTION;', N'@UserId nvarchar(450), @HostUuid uniqueidentifier, @SecondHostUuid uniqueidentifier, @OffHostUuid uniqueidentifier',
        @UserId, @HostUuid, @SecondHostUuid, @OffHostUuid;
