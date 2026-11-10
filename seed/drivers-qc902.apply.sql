-- QC-902: in DRIVERS_SQL_DATABASE (a database with the QC-902 migrations 022-026), gives the throwaway driver $(UserId)
--   * a link to the local host $(HostUuid), marked as synced (SyncRequestedAt and SyncedAt now) so the resync sweep leaves it alone,
--   * one mirror assignment (Notes 'e2e-qc902') with its as-hauled copy: VendorUUID $(VendorUuid), VendorName $(VendorName),
--     TruckUUID $(TruckUuid), TruckName $(TruckName), HostName $(AsHauledHostName) and TruckNumber $(AssignmentTruckNumber),
--   * one dispatch message on that assignment, so the driver has a message thread.
-- The Driver account (auth.* and app.DriverSettings) is drivers-qc902-account.apply.sql. drivers-qc902.remove.sql deletes both.
-- QC-902 one list: UserUUID / DriverUserUUID / HostUUID since DRIVERS migrations 027-030, UserID_FK / HostID_FK before;
-- each schema's statements run through sp_executesql.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverSettings', N'U') IS NULL OR COL_LENGTH(N'app.OrderAssignments', N'VendorUUID') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 migrations (022-026).', 1;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50002, 'The local host is not an active host in the drivers database.', 1;

DECLARE @VendorUuid uniqueidentifier = N'$(VendorUuid)';
DECLARE @VendorName nvarchar(200) = N'$(VendorName)';
DECLARE @TruckUuid uniqueidentifier = N'$(TruckUuid)';
DECLARE @TruckName nvarchar(200) = N'$(TruckName)';
DECLARE @AsHauledHostName nvarchar(200) = N'$(AsHauledHostName)';
DECLARE @TruckNumber nvarchar(100) = N'$(AssignmentTruckNumber)';
DECLARE @Parameters nvarchar(max) = N'@UserId nvarchar(450), @HostUuid uniqueidentifier, @VendorUuid uniqueidentifier, @VendorName nvarchar(200), @TruckUuid uniqueidentifier, @TruckName nvarchar(200), @AsHauledHostName nvarchar(200), @TruckNumber nvarchar(100)';

IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NOT NULL
    EXEC sp_executesql N'
BEGIN TRANSACTION;

DELETE app.Messages WHERE DriverUserUUID = @UserId;
DELETE app.OrderAssignments WHERE DriverUserUUID = @UserId;
DELETE app.DriverHostLinks WHERE UserUUID = @UserId;

INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
VALUES (@UserId, @HostUuid, N''e2e'', N''e2e'', GETUTCDATE(), GETUTCDATE(), N''E2E QC-902 Driver'');

DECLARE @AssignmentUuid uniqueidentifier = NEWID();

INSERT app.OrderAssignments
(
    HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
    JobDocNameWithPrefix, Origin, Destination, MaterialName, TruckNumber, CanUploadTickets, CreatedBy, UpdatedBy,
    VendorUUID, VendorName, TruckUUID, TruckName, HostName
)
VALUES
(
    @HostUuid, @UserId, @AssignmentUuid, 1, CAST(GETDATE() AS date), 2, 1, 10, N''e2e-qc902'',
    N''E2E-QC902'', N''E2E QC-902 Quarry'', N''E2E QC-902 Site'', N''E2E QC-902 Gravel'', @TruckNumber, 0, N''e2e'', N''e2e'',
    @VendorUuid, @VendorName, @TruckUuid, @TruckName, @AsHauledHostName
);

INSERT app.Messages (HostUUID, DriverUserUUID, MessageUUID, OrderAssignmentUUID, Version, IsFromDispatch, MessageType, MessageBody, SentAt, CreatedBy, UpdatedBy)
VALUES (@HostUuid, @UserId, NEWID(), @AssignmentUuid, 1, 1, 30, N''e2e-qc902 dispatch message'', GETUTCDATE(), N''e2e'', N''e2e'');

COMMIT TRANSACTION;', @Parameters, @UserId, @HostUuid, @VendorUuid, @VendorName, @TruckUuid, @TruckName, @AsHauledHostName, @TruckNumber;
ELSE
    EXEC sp_executesql N'
DECLARE @HostId int = (SELECT HostID FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1);
BEGIN TRANSACTION;

DELETE app.Messages WHERE UserID_FK = @UserId;
DELETE app.OrderAssignments WHERE UserID_FK = @UserId;
DELETE app.DriverHostLinks WHERE UserID_FK = @UserId;

INSERT app.DriverHostLinks (UserID_FK, HostID_FK, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
VALUES (@UserId, @HostId, N''e2e'', N''e2e'', GETUTCDATE(), GETUTCDATE(), N''E2E QC-902 Driver'');

DECLARE @AssignmentUuid uniqueidentifier = NEWID();

INSERT app.OrderAssignments
(
    HostID_FK, UserID_FK, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
    JobDocNameWithPrefix, Origin, Destination, MaterialName, TruckNumber, CanUploadTickets, CreatedBy, UpdatedBy,
    VendorUUID, VendorName, TruckUUID, TruckName, HostName
)
VALUES
(
    @HostId, @UserId, @AssignmentUuid, 1, CAST(GETDATE() AS date), 2, 1, 10, N''e2e-qc902'',
    N''E2E-QC902'', N''E2E QC-902 Quarry'', N''E2E QC-902 Site'', N''E2E QC-902 Gravel'', @TruckNumber, 0, N''e2e'', N''e2e'',
    @VendorUuid, @VendorName, @TruckUuid, @TruckName, @AsHauledHostName
);

INSERT app.Messages (HostID_FK, UserID_FK, MessageUUID, OrderAssignmentUUID, Version, IsFromDispatch, MessageType, MessageBody, SentAt, CreatedBy, UpdatedBy)
VALUES (@HostId, @UserId, NEWID(), @AssignmentUuid, 1, 1, 30, N''e2e-qc902 dispatch message'', GETUTCDATE(), N''e2e'', N''e2e'');

COMMIT TRANSACTION;', @Parameters, @UserId, @HostUuid, @VendorUuid, @VendorName, @TruckUuid, @TruckName, @AsHauledHostName, @TruckNumber;
