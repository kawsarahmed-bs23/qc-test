-- QC-805: link a driver message to one of the driver's assignments, and offer only the responses that fit it.
-- For $(DriverId) (an active driver with a phone and no live assignment from yesterday on) it copies the order of
-- that driver's latest live assignment into a new order (yesterday to tomorrow, one truck needed) and gives the
-- driver four assignments on it: today Accepted starting 23:59 (start not passed), today Accepted starting 00:00
-- (start passed, so No Show is offered), tomorrow Pending 06:30, yesterday Accepted 07:00 (never started). The
-- 23:59 one is inserted first so the thread's date/start order differs from id order. Then it adds eight inbound
-- SMS from the driver, none actioned: m1, m2, m6 unlinked; m3, m5, m7 on today's 23:59 assignment; m4 on
-- yesterday's; m8 on today's 00:00 assignment.
-- Every row is marked E2E-QC805 (order and assignment Notes, message bodies). Re-running replaces the rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC805';
DECLARE @DriverId nvarchar(450) = N'$(DriverId)';
DECLARE @CreatedUtc datetime = DATEADD(MINUTE, -10, GETUTCDATE());
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date);
DECLARE @Tomorrow date = DATEADD(DAY, 1, @Today);
DECLARE @Yesterday date = DATEADD(DAY, -1, @Today);

BEGIN TRANSACTION;

DECLARE @OldAssignments TABLE (Id int PRIMARY KEY);
INSERT @OldAssignments
SELECT OrderAssignmentID FROM app.OrderAssignments
WHERE Notes = @Marker OR OrderID_FK IN (SELECT OrderID FROM app.Orders WHERE Notes = @Marker);

DECLARE @OldMessages TABLE (Id int PRIMARY KEY);
INSERT @OldMessages
SELECT MessageID FROM app.Messages
WHERE MessageBody LIKE N'%' + @Marker + N'%' OR OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);

DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @OldMessages);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @OldAssignments);
DELETE app.Orders WHERE Notes = @Marker;
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments) OR MessageID_FK IN (SELECT Id FROM @OldMessages);

DECLARE @TemplateAssignmentId int =
(
    SELECT TOP 1 a.OrderAssignmentID
    FROM app.OrderAssignments a
    JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    JOIN app.Jobs j ON j.JobID = o.JobID_FK
    WHERE a.DriverUserID_FK = @DriverId
      AND a.Active = 1
      AND o.Active = 1
      AND a.AssignmentType = 10
      AND a.TruckID_FK IS NOT NULL
      AND j.IsNightShift = 0
    ORDER BY a.AssignmentDate DESC, a.OrderAssignmentID DESC
);

IF @TemplateAssignmentId IS NULL
    THROW 50051, 'The driver has no live truck assignment on a day-shift job to copy.', 1;

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, IsQuote,
    Notes, FulfillmentType, OrderQuantity, UnitID_FK, OrderStatusID_FK
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, o.JobID_FK, o.DispatcherUserID_FK, o.AreaID_FK, o.TruckTypeID_FK, 1,
    @Yesterday, @Tomorrow, '07:00', '15:00', o.LoadsPerTruck, o.EstimatedTripMins, 0,
    @Marker, o.FulfillmentType, o.OrderQuantity, o.UnitID_FK, 1
FROM app.OrderAssignments a
JOIN app.Orders o ON o.OrderID = a.OrderID_FK
WHERE a.OrderAssignmentID = @TemplateAssignmentId;

DECLARE @OrderId int = SCOPE_IDENTITY();

DECLARE @Seeded TABLE (Slot varchar(10), Id int);

INSERT app.OrderAssignments
(
    Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, TruckCount,
    AssignmentDate, TimeWindowStart, TimeWindowEnd, LoadsAssigned, EstimatedTripMins, ActualAvgTripMins,
    NotificationSent, NotificationSentAt, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK
)
OUTPUT CASE WHEN inserted.AssignmentDate = @Tomorrow THEN 'tomorrow'
            WHEN inserted.AssignmentDate = @Yesterday THEN 'yesterday'
            WHEN inserted.TimeWindowStart = '00:00' THEN 'noshow'
            ELSE 'today' END,
       inserted.OrderAssignmentID
INTO @Seeded (Slot, Id)
SELECT
    @CreatedUtc, @CreatedUtc, 1, @OrderId, a.VendorID_FK, a.DriverUserID_FK, a.TruckID_FK, NULL,
    d.Day, d.StartAt, d.EndAt, a.LoadsAssigned, a.EstimatedTripMins, NULL,
    0, NULL, @Marker, a.AssignmentType, a.FulfillmentType, d.Status
FROM app.OrderAssignments a
CROSS JOIN (VALUES
    (1, @Today, CAST('23:59' AS time), CAST('23:59:59' AS time), 2),
    (2, @Today, CAST('00:00' AS time), CAST('08:00' AS time), 2),
    (3, @Tomorrow, CAST('06:30' AS time), CAST('14:30' AS time), 1),
    (4, @Yesterday, CAST('07:00' AS time), CAST('15:00' AS time), 2)
) AS d (Seq, Day, StartAt, EndAt, Status)
WHERE a.OrderAssignmentID = @TemplateAssignmentId
ORDER BY d.Seq;

DECLARE @TodayId int = (SELECT Id FROM @Seeded WHERE Slot = 'today');
DECLARE @TomorrowId int = (SELECT Id FROM @Seeded WHERE Slot = 'tomorrow');
DECLARE @YesterdayId int = (SELECT Id FROM @Seeded WHERE Slot = 'yesterday');
DECLARE @NoShowId int = (SELECT Id FROM @Seeded WHERE Slot = 'noshow');
DECLARE @VendorId int = (SELECT VendorID_FK FROM app.OrderAssignments WHERE OrderAssignmentID = @TodayId);
DECLARE @Phone varchar(20) = (SELECT LEFT(PhoneNumber, 20) FROM auth.Users WHERE Id = @DriverId);

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, PhoneNumber,
    SentAt, IsActioned, Direction, MessageType, Channel
)
OUTPUT 'm' + RIGHT(inserted.MessageBody, 1), inserted.MessageID INTO @Seeded (Slot, Id)
SELECT
    DATEADD(SECOND, m.Seq * 20, @CreatedUtc), DATEADD(SECOND, m.Seq * 20, @CreatedUtc), 1,
    m.AssignmentId, @DriverId, CASE WHEN m.AssignmentId IS NULL THEN NULL ELSE @VendorId END,
    CONCAT(@Marker, N' ', m.Body, N' #', m.Seq), @Phone,
    DATEADD(SECOND, m.Seq * 20, @CreatedUtc), 0, 10, 40, 10
FROM (VALUES
    (1, CAST(NULL AS int), N'running a bit behind on the next load'),
    (2, NULL, N'which job is this for, the yard says another one'),
    (3, @TodayId, N'stuck in traffic, about 20 minutes late'),
    (4, @YesterdayId, N'sorry, truck would not start yesterday'),
    (5, @TodayId, N'loaded and heading out now'),
    (6, NULL, N'call me when you can'),
    (7, @TodayId, N'flat tyre at the pit entrance'),
    (8, @NoShowId, N'overslept, not coming in today')
) AS m (Seq, AssignmentId, Body);

COMMIT TRANSACTION;

SELECT CONCAT('SEED order=', @OrderId,
    ';today=', @TodayId, ';tomorrow=', @TomorrowId, ';yesterday=', @YesterdayId, ';noshow=', @NoShowId,
    ';m1=', (SELECT Id FROM @Seeded WHERE Slot = 'm1'), ';m2=', (SELECT Id FROM @Seeded WHERE Slot = 'm2'),
    ';m3=', (SELECT Id FROM @Seeded WHERE Slot = 'm3'), ';m4=', (SELECT Id FROM @Seeded WHERE Slot = 'm4'),
    ';m5=', (SELECT Id FROM @Seeded WHERE Slot = 'm5'), ';m6=', (SELECT Id FROM @Seeded WHERE Slot = 'm6'),
    ';m7=', (SELECT Id FROM @Seeded WHERE Slot = 'm7'), ';m8=', (SELECT Id FROM @Seeded WHERE Slot = 'm8'));
