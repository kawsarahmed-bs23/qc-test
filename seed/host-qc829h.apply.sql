-- QC-829 (host API): host-only data for the host driver sync cases (tests/27-host-driver-sync.spec.ts).
--   * three host auth.Users rows, e2e.qc829h.driver, e2e.qc829h.driver2 (both role Driver) and e2e.qc829h.dispatcher
--     (host role Admin in the host organisation, EnvironmentSetting HostOrganisationId), all signing in to the host API with
--     the password of $(SourceEmail): its PasswordHash is read from [$(IdentityDb)] (same server, read only). Nothing is
--     written to Identity or DRIVERS: the drivers have no driver-host link, so the Drivers API never mirrors them.
--   * one order per driver assignment, so voiding or editing one order touches one assignment. Every order has
--     Notes 'e2e-qc829h', every assignment 'e2e-qc829h <role>', all dated today (the host's TimeZoneSettings:TimeZoneId):
--       work (Pending: accept, begin-haul, end-haul, ticket upload), other (Pending: the batched accept),
--       edit (Pending: its order is edited), gone (Pending: its order is voided), move (Pending: moved to driver2),
--       chat (Running, because the host only lets a dispatcher message a driver with an active assignment today).
--     Job, truck type, vendor and truck are copied from the newest driver assignment (read only).
--   * one unread in-app dispatch message on work (to the driver) and one on move that names no driver.
-- Re-running replaces everything; host-qc829h.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc829h';
DECLARE @DriverEmail nvarchar(256) = N'e2e.qc829h.driver@quarryconnect.test';
DECLARE @SecondDriverEmail nvarchar(256) = N'e2e.qc829h.driver2@quarryconnect.test';
DECLARE @DispatcherEmail nvarchar(256) = N'e2e.qc829h.dispatcher@quarryconnect.test';

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50004, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].auth.Users WHERE NormalizedEmail = UPPER(N'$(SourceEmail)'));
IF @PasswordHash IS NULL
    THROW 50002, 'The source test account does not exist in Identity or has no password.', 1;

DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

DECLARE @JobId int, @TruckTypeId int, @DispatcherUserId nvarchar(450), @VendorId int, @TruckId int, @DriverOrganisationId int;
SELECT TOP 1
    @JobId = o.JobID_FK, @TruckTypeId = o.TruckTypeID_FK, @DispatcherUserId = o.DispatcherUserID_FK,
    @VendorId = oa.VendorID_FK, @TruckId = oa.TruckID_FK
FROM app.OrderAssignments oa
JOIN app.Orders o ON o.OrderID = oa.OrderID_FK
WHERE oa.AssignmentType = 10 AND oa.TruckID_FK IS NOT NULL AND oa.Active = 1 AND o.Active = 1
  AND ISNULL(oa.Notes, N'') NOT LIKE N'e2e-%'
ORDER BY oa.OrderAssignmentID DESC;
IF @JobId IS NULL
    THROW 50003, 'No driver assignment to copy the job, vendor and truck from.', 1;

SELECT TOP 1 @DriverOrganisationId = u.OrganisationIdFk
FROM auth.Users u JOIN auth.UserToRoles r ON r.UserId = u.Id
WHERE r.RoleName = N'Driver' AND u.OrganisationIdFk IS NOT NULL AND u.NormalizedEmail NOT LIKE N'E2E.%';

DECLARE @Users TABLE (Email nvarchar(256) PRIMARY KEY, Id nvarchar(450), LastName nvarchar(100), RoleName nvarchar(50), OrganisationId int, LocationId int);
INSERT @Users VALUES
    (@DriverEmail, LOWER(CONVERT(nvarchar(36), NEWID())), N'QC-829 Host driver', N'Driver', @DriverOrganisationId, 0),
    (@SecondDriverEmail, LOWER(CONVERT(nvarchar(36), NEWID())), N'QC-829 Host second driver', N'Driver', @DriverOrganisationId, 0),
    (@DispatcherEmail, LOWER(CONVERT(nvarchar(36), NEWID())), N'QC-829 Host dispatcher', N'Admin', @HostOrganisationId,
     (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL));

IF EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC829H.%@QUARRYCONNECT.TEST')
    THROW 50005, 'e2e.qc829h users are still in the host database; run host-qc829h.remove.sql first.', 1;

DECLARE @DriverId nvarchar(450) = (SELECT Id FROM @Users WHERE Email = @DriverEmail);

BEGIN TRANSACTION;

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT
    u.Id, u.Email, UPPER(u.Email), u.Email, UPPER(u.Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'E2E', u.LastName,
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), u.OrganisationId, u.LocationId, 0, 1, 0, 0
FROM @Users u;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, RoleName FROM @Users;

DECLARE @Roles TABLE (Role nvarchar(20) PRIMARY KEY, StatusId int);
INSERT @Roles VALUES (N'work', 1), (N'other', 1), (N'edit', 1), (N'gone', 1), (N'move', 1), (N'chat', 4);

DECLARE @Role nvarchar(20), @StatusId int, @OrderId int;
DECLARE roles CURSOR LOCAL FAST_FORWARD FOR SELECT Role, StatusId FROM @Roles;
OPEN roles;
FETCH NEXT FROM roles INTO @Role, @StatusId;
WHILE @@FETCH_STATUS = 0
BEGIN
    INSERT app.Orders
    (
        Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
        OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK
    )
    VALUES
    (
        GETUTCDATE(), GETUTCDATE(), 1, @JobId, @DispatcherUserId, NULL, @TruckTypeId, 1,
        @Today, DATEADD(DAY, 1, @Today), '00:00', '23:59', 4, 0, @Marker, 10, 2
    );
    SET @OrderId = SCOPE_IDENTITY();

    INSERT app.OrderAssignments
    (
        Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, AssignmentDate, TimeWindowStart, TimeWindowEnd,
        LoadsAssigned, NotificationSent, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK, OrderAssignmentUUID
    )
    VALUES
    (
        GETUTCDATE(), GETUTCDATE(), 1, @OrderId, @VendorId, @DriverId, @TruckId, @Today, '00:00', '23:59',
        4, 0, @Marker + N' ' + @Role, 10, 10, @StatusId, NEWID()
    );

    FETCH NEXT FROM roles INTO @Role, @StatusId;
END
CLOSE roles;
DEALLOCATE roles;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, SentAt, IsActioned,
    Direction, MessageType, Channel, MessageUUID
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, oa.OrderAssignmentID, CASE WHEN oa.Notes = @Marker + N' work' THEN @DriverId END, @VendorId,
       CASE WHEN oa.Notes = @Marker + N' work' THEN N'e2e-qc829h dispatch note: load 1 is ready' ELSE N'e2e-qc829h dispatch note: this job may move' END,
       GETUTCDATE(), 0, 20, 30, 20, NEWID()
FROM app.OrderAssignments oa
WHERE oa.DriverUserID_FK = @DriverId AND oa.Notes IN (@Marker + N' work', @Marker + N' move');

COMMIT TRANSACTION;
