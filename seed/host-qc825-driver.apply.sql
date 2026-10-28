-- QC-825: host-side data for the throwaway Identity driver $(UserId) ($(Email)) in the host database, for the Drivers API
-- mirror cases (tests/23-drivers-mirror.spec.ts).
--   * auth.Users row with the same Id as the Identity sub, the Driver role and the Identity user's password hash, read from
--     [$(IdentityDb)] (same server), so the host's own api/account/login works for AC9.
--   * one order and four driver assignments, all Pending, every one marked in Notes ('e2e-qc825 <role>'):
--       work (today), tomorrow (today + 1), cancel (today), refuse (today), move (today, reassigned by DMIR-14), reject (today, DMIR-16), haul (today, DMIR-17…20). "Today" is the host's day in
--       TimeZoneSettings:TimeZoneId. Job, truck type, vendor and truck are copied from the newest driver assignment
--       (read only); nothing else is changed.
--   * one unread in-app dispatch message on the work assignment, and one on the move assignment that names no driver
--     (DriverUserID_FK NULL), so its thread follows the assignment when it is reassigned.
--   * a host-only dispatcher, e2e.qc825.dispatcher@quarryconnect.test, with the host role Admin in the host organisation
--     (EnvironmentSetting HostOrganisationId) and the same password hash, to send a dispatch message through the host API.
-- Nothing is mirrored until the Drivers API asks this host to resync the driver (drivers-qc825.apply.sql adds the link).
-- Re-running replaces everything; host-qc825.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @Marker nvarchar(50) = N'e2e-qc825';
DECLARE @DispatcherEmail nvarchar(256) = N'e2e.qc825.dispatcher@quarryconnect.test';
DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50004, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

IF @Email NOT LIKE N'e2e.qc825.%@quarryconnect.test'
    THROW 50001, 'The throwaway driver email must start with e2e.qc825. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].dbo.Users WHERE Id = @UserId AND NormalizedEmail = UPPER(@Email));
IF @PasswordHash IS NULL
    THROW 50002, 'The throwaway Identity driver does not exist; run identity-qc825-user.apply.sql first.', 1;

DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

DECLARE @JobId int, @TruckTypeId int, @DispatcherUserId nvarchar(450), @VendorId int, @TruckId int, @OrganisationId int;
SELECT TOP 1
    @JobId = o.JobID_FK, @TruckTypeId = o.TruckTypeID_FK, @DispatcherUserId = o.DispatcherUserID_FK,
    @VendorId = oa.VendorID_FK, @TruckId = oa.TruckID_FK
FROM app.OrderAssignments oa
JOIN app.Orders o ON o.OrderID = oa.OrderID_FK
WHERE oa.AssignmentType = 10 AND oa.TruckID_FK IS NOT NULL AND oa.Active = 1 AND o.Active = 1
  AND ISNULL(oa.Notes, N'') NOT LIKE @Marker + N'%'
ORDER BY oa.OrderAssignmentID DESC;
IF @JobId IS NULL
    THROW 50003, 'No driver assignment to copy the job, vendor and truck from.', 1;

SELECT TOP 1 @OrganisationId = u.OrganisationIdFk
FROM auth.Users u JOIN auth.UserToRoles r ON r.UserId = u.Id
WHERE r.RoleName = N'Driver' AND u.OrganisationIdFk IS NOT NULL AND u.NormalizedEmail NOT LIKE N'E2E.QC825.%';

BEGIN TRANSACTION;

DECLARE @OldAssignments TABLE (Id int PRIMARY KEY);
INSERT @OldAssignments SELECT OrderAssignmentID FROM app.OrderAssignments WHERE DriverUserID_FK = @UserId;
DECLARE @OldOrders TABLE (Id int PRIMARY KEY);
INSERT @OldOrders SELECT DISTINCT OrderID_FK FROM app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @OldAssignments);

DELETE app.DriverMirrorSubscriptions WHERE UserID_FK = @UserId;
DELETE app.DriverMirrorChanges WHERE UserID_FK = @UserId;
DELETE app.TripGps WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.Messages WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.Trips WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @OldAssignments);
DELETE app.Orders WHERE OrderID IN (SELECT Id FROM @OldOrders) AND Notes = @Marker;
DELETE auth.UserToRoles WHERE UserId = @UserId;
DELETE auth.Users WHERE Id = @UserId;

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, Discriminator, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'Users', N'E2E', N'QC-825 Driver',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @OrganisationId, 0, 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Driver');

DELETE r FROM auth.UserToRoles r JOIN auth.Users u ON u.Id = r.UserId WHERE u.NormalizedEmail = UPPER(@DispatcherEmail);
DELETE auth.Users WHERE NormalizedEmail = UPPER(@DispatcherEmail);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, Discriminator, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    LOWER(CONVERT(nvarchar(36), NEWID())), @DispatcherEmail, UPPER(@DispatcherEmail), @DispatcherEmail, UPPER(@DispatcherEmail), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'Users', N'E2E', N'QC-825 Dispatcher',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @HostOrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @HostOrganisationId AND OrganisationLocationIdFk IS NOT NULL), 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, N'Admin' FROM auth.Users WHERE NormalizedEmail = UPPER(@DispatcherEmail);

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK
)
VALUES
(
    GETUTCDATE(), GETUTCDATE(), 1, @JobId, @DispatcherUserId, NULL, @TruckTypeId, 4,
    @Today, DATEADD(DAY, 1, @Today), '00:00', '23:59', 4, 0, @Marker, 10, 2
);
DECLARE @OrderId int = SCOPE_IDENTITY();

INSERT app.OrderAssignments
(
    Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, AssignmentDate, TimeWindowStart, TimeWindowEnd,
    LoadsAssigned, NotificationSent, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK, OrderAssignmentUUID
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, @OrderId, @VendorId, @UserId, @TruckId, v.AssignmentDate, '00:00', '23:59',
       4, 0, @Marker + N' ' + v.Role, 10, 10, 1, NEWID()
FROM (VALUES (N'work', @Today), (N'tomorrow', DATEADD(DAY, 1, @Today)), (N'cancel', @Today), (N'refuse', @Today), (N'move', @Today), (N'reject', @Today), (N'haul', @Today)) AS v (Role, AssignmentDate);

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, SentAt, IsActioned,
    Direction, MessageType, Channel, MessageUUID
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, oa.OrderAssignmentID, @UserId, @VendorId, N'e2e-qc825 dispatch note: load 1 is ready', GETUTCDATE(), 0,
       20, 30, 20, NEWID()
FROM app.OrderAssignments oa
WHERE oa.DriverUserID_FK = @UserId AND oa.Notes = @Marker + N' work';

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, SentAt, IsActioned,
    Direction, MessageType, Channel, MessageUUID
)
SELECT GETUTCDATE(), GETUTCDATE(), 1, oa.OrderAssignmentID, NULL, @VendorId, N'e2e-qc825 dispatch note: this job may move to another driver', GETUTCDATE(), 0,
       20, 30, 20, NEWID()
FROM app.OrderAssignments oa
WHERE oa.DriverUserID_FK = @UserId AND oa.Notes = @Marker + N' move';

COMMIT TRANSACTION;
