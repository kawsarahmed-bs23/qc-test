-- QC-938 (D109): in DRIVERS_SQL_DATABASE (QC-902 one list: migrations 022-030, VendorName/HostName on app.OrderAssignments),
-- gives the throwaway driver $(UserId) two throwaway hosts, both dispatch on, in Central time, with a message endpoint
-- nothing listens on (tcp://localhost:6299):
--   * 'E2E QC-938 Statewide Materials' and 'E2E QC-938 Second Host',
-- an active link to each, marked synced (SyncRequestedAt and SyncedAt now) so the resync sweep leaves them alone, and five
-- of today's jobs (today in Central time), Notes 'e2e-qc938 <role>':
--   * offer        first host, Pending,  VendorName 'E2E QC-938 Delgado Hauling', TruckNumber '938-P', as-hauled HostName,
--   * accepted     first host, Accepted, the same Vendor, TruckNumber '101', as-hauled HostName,
--   * second host  second host, Accepted, the same Vendor and TruckNumber '101', its own as-hauled HostName,
--   * no vendor    first host, Accepted, an older row: no Vendor, Truck, TruckNumber or as-hauled HostName,
--   * no truck     first host, Accepted, the Vendor and a TruckName but no TruckNumber.
-- drivers-qc938.remove.sql deletes the driver's rows and every 'E2E QC-938%' host with whatever is attached to it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL OR COL_LENGTH(N'app.OrderAssignments', N'VendorName') IS NULL
    OR COL_LENGTH(N'app.OrderAssignments', N'HostName') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 one-list migrations (VendorName, HostName, UserUUID).', 1;

DECLARE @UserId uniqueidentifier = N'$(UserId)';

EXEC sp_executesql N'
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE N''Central Standard Time'' AS date);
DECLARE @FirstHost uniqueidentifier = NEWID();
DECLARE @SecondHost uniqueidentifier = NEWID();
DECLARE @Vendor uniqueidentifier = NEWID();
DECLARE @Vendor2Name nvarchar(200) = N''E2E QC-938 Delgado Hauling'';

BEGIN TRANSACTION;

DELETE app.Messages WHERE DriverUserUUID = @UserId;
DELETE app.OrderAssignments WHERE DriverUserUUID = @UserId;
DELETE app.DriverHostLinks WHERE UserUUID = @UserId;

INSERT app.Hosts (HostUUID, HostName, Created, Updated, Active, CreatedBy, UpdatedBy, MessageEndpoint, DispatchEnabled, TimeZoneId)
VALUES
    (@FirstHost, N''E2E QC-938 Statewide Materials'', GETUTCDATE(), GETUTCDATE(), 1, N''e2e'', N''e2e'', N''tcp://localhost:6299'', 1, N''Central Standard Time''),
    (@SecondHost, N''E2E QC-938 Second Host'', GETUTCDATE(), GETUTCDATE(), 1, N''e2e'', N''e2e'', N''tcp://localhost:6299'', 1, N''Central Standard Time'');

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
VALUES
    (@UserId, @FirstHost, N''e2e'', N''e2e'', GETUTCDATE(), GETUTCDATE(), N''E2E QC-938 Driver''),
    (@UserId, @SecondHost, N''e2e'', N''e2e'', GETUTCDATE(), GETUTCDATE(), N''E2E QC-938 Driver'');

INSERT app.OrderAssignments
    (HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
     JobDocNameWithPrefix, Origin, Destination, MaterialName, CanUploadTickets, CreatedBy, UpdatedBy,
     VendorUUID, VendorName, TruckUUID, TruckName, TruckNumber, HostName)
VALUES
    (@FirstHost, @UserId, NEWID(), 1, @Today, 1, 2, 10, N''e2e-qc938 offer'',
     N''E2E-QC938-OFFER'', N''E2E QC-938 Quarry'', N''E2E QC-938 Site'', N''E2E Gravel'', 0, N''e2e'', N''e2e'',
     @Vendor, @Vendor2Name, NEWID(), N''E2E QC-938 Truck P'', N''938-P'', N''E2E QC-938 Statewide Materials (as hauled)''),
    (@FirstHost, @UserId, NEWID(), 1, @Today, 2, 2, 10, N''e2e-qc938 accepted'',
     N''E2E-QC938-ACC'', N''E2E QC-938 Quarry'', N''E2E QC-938 Site'', N''E2E Gravel'', 0, N''e2e'', N''e2e'',
     @Vendor, @Vendor2Name, NEWID(), N''E2E QC-938 Truck 101'', N''101'', N''E2E QC-938 Statewide Materials (as hauled)''),
    (@SecondHost, @UserId, NEWID(), 1, @Today, 2, 2, 10, N''e2e-qc938 second host'',
     N''E2E-QC938-H2'', N''E2E QC-938 Quarry 2'', N''E2E QC-938 Site 2'', N''E2E Gravel'', 0, N''e2e'', N''e2e'',
     @Vendor, @Vendor2Name, NEWID(), N''E2E QC-938 Truck 101'', N''101'', N''E2E QC-938 Second Host (as hauled)''),
    (@FirstHost, @UserId, NEWID(), 1, @Today, 2, 1, 10, N''e2e-qc938 no vendor'',
     N''E2E-QC938-OLD'', N''E2E QC-938 Quarry'', N''E2E QC-938 Site'', N''E2E Gravel'', 0, N''e2e'', N''e2e'',
     NULL, NULL, NULL, NULL, NULL, NULL),
    (@FirstHost, @UserId, NEWID(), 1, @Today, 2, 1, 10, N''e2e-qc938 no truck'',
     N''E2E-QC938-NOTRUCK'', N''E2E QC-938 Quarry'', N''E2E QC-938 Site'', N''E2E Gravel'', 0, N''e2e'', N''e2e'',
     @Vendor, @Vendor2Name, NEWID(), N''E2E QC-938 Truck N'', NULL, N''E2E QC-938 Statewide Materials (as hauled)'');

COMMIT TRANSACTION;', N'@UserId uniqueidentifier', @UserId;
