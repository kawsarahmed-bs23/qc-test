-- QC-806: Comms by day. For three real active drivers picked by the spec it adds:
--   $(DriverA): a Pending assignment tomorrow (07:00), twelve inbound SMS today on whole seconds (the last one unseen and not actioned,
--               the others seen and actioned) and 45 older inbound SMS spread over the days before today. The older
--               ones come in pairs that share a Created time, so a 30-message page boundary falls inside a pair and
--               the (Created, MessageId) order is what decides it.
--   $(DriverB): a Pending assignment tomorrow (06:30) and nothing else.
--   $(DriverC): nothing; the spec only checks that the driver has nothing today or tomorrow.
-- The assignments sit on a new order copied from the latest live day-shift truck assignment of any driver (one truck
-- needed, today to tomorrow). Every row is marked E2E-QC806 (order and assignment Notes, message bodies). Re-running
-- replaces the rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC806';
DECLARE @DriverA nvarchar(450) = N'$(DriverA)';
DECLARE @DriverB nvarchar(450) = N'$(DriverB)';
DECLARE @NowUtc datetime = GETUTCDATE();
DECLARE @NowSecondUtc datetime = DATEADD(MILLISECOND, -DATEPART(MILLISECOND, @NowUtc), @NowUtc);
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date);
DECLARE @Tomorrow date = DATEADD(DAY, 1, @Today);
DECLARE @TodayStartUtc datetime = CAST(CAST(@Today AS datetime) AT TIME ZONE 'Central Standard Time' AT TIME ZONE 'UTC' AS datetime);

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
IF OBJECT_ID(N'app.DriverMirrorChanges', N'U') IS NOT NULL
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments) OR MessageID_FK IN (SELECT Id FROM @OldMessages);

DECLARE @TemplateAssignmentId int =
(
    SELECT TOP 1 a.OrderAssignmentID
    FROM app.OrderAssignments a
    JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    JOIN app.Jobs j ON j.JobID = o.JobID_FK
    WHERE a.DriverUserID_FK IS NOT NULL
      AND a.Active = 1
      AND o.Active = 1
      AND a.AssignmentType = 10
      AND a.TruckID_FK IS NOT NULL
      AND j.IsNightShift = 0
    ORDER BY a.AssignmentDate DESC, a.OrderAssignmentID DESC
);

IF @TemplateAssignmentId IS NULL
    THROW 50061, 'There is no live truck assignment on a day-shift job to copy.', 1;

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, IsQuote,
    Notes, FulfillmentType, OrderQuantity, UnitID_FK, OrderStatusID_FK
)
SELECT
    @NowUtc, @NowUtc, 1, o.JobID_FK, o.DispatcherUserID_FK, o.AreaID_FK, o.TruckTypeID_FK, 1,
    @Today, @Tomorrow, '07:00', '15:00', o.LoadsPerTruck, o.EstimatedTripMins, 0,
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
OUTPUT CASE WHEN inserted.DriverUserID_FK = @DriverA THEN 'a' ELSE 'b' END, inserted.OrderAssignmentID
INTO @Seeded (Slot, Id)
SELECT
    @NowUtc, @NowUtc, 1, @OrderId, a.VendorID_FK, d.DriverId, a.TruckID_FK, NULL,
    @Tomorrow, d.StartAt, d.EndAt, a.LoadsAssigned, a.EstimatedTripMins, NULL,
    0, NULL, @Marker, a.AssignmentType, a.FulfillmentType, 1
FROM app.OrderAssignments a
CROSS JOIN (VALUES
    (1, @DriverA, CAST('07:00' AS time), CAST('15:00' AS time)),
    (2, @DriverB, CAST('06:30' AS time), CAST('14:30' AS time))
) AS d (Seq, DriverId, StartAt, EndAt)
WHERE a.OrderAssignmentID = @TemplateAssignmentId
ORDER BY d.Seq;

DECLARE @PhoneA varchar(20) = (SELECT LEFT(PhoneNumber, 20) FROM auth.Users WHERE Id = @DriverA);

DECLARE @Numbers TABLE (Seq int PRIMARY KEY);
INSERT @Numbers SELECT TOP 45 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) FROM sys.all_objects;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, PhoneNumber,
    SentAt, IsActioned, ActionedAt, SeenByDispatcherAt, Direction, MessageType, Channel
)
SELECT
    t.At, t.At, 1, NULL, @DriverA, NULL, CONCAT(@Marker, N' older #', RIGHT(CONCAT('0', n.Seq), 2)), @PhoneA,
    t.At, 1, t.At, t.At, 10, 40, 10
FROM @Numbers n
CROSS APPLY (SELECT DATEADD(HOUR, -5 * ((46 - n.Seq) / 2 + 1), @TodayStartUtc) AS At) t
ORDER BY n.Seq;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, MessageBody, PhoneNumber,
    SentAt, IsActioned, ActionedAt, SeenByDispatcherAt, Direction, MessageType, Channel
)
SELECT
    t.At, t.At, 1, NULL, @DriverA, NULL, CONCAT(@Marker, N' today #', RIGHT(CONCAT('0', n.Seq), 2)), @PhoneA,
    t.At, CASE WHEN n.Seq = 12 THEN 0 ELSE 1 END, CASE WHEN n.Seq = 12 THEN NULL ELSE t.At END,
    CASE WHEN n.Seq = 12 THEN NULL ELSE t.At END, 10, 40, 10
FROM @Numbers n
CROSS APPLY (SELECT DATEADD(SECOND, -20 * (13 - n.Seq), DATEADD(MINUTE, -5, @NowSecondUtc)) AS At) t
WHERE n.Seq <= 12
ORDER BY n.Seq;

IF EXISTS (SELECT 1 FROM app.Messages WHERE MessageBody LIKE @Marker + N' today #%' AND Created < @TodayStartUtc)
    THROW 50062, 'The app day started less than ten minutes ago; run again later so today''s messages fall on today.', 1;

COMMIT TRANSACTION;

SELECT CONCAT('SEED order=', @OrderId,
    ';a=', (SELECT Id FROM @Seeded WHERE Slot = 'a'), ';b=', (SELECT Id FROM @Seeded WHERE Slot = 'b'),
    ';latest=', (SELECT MessageID FROM app.Messages WHERE MessageBody = @Marker + N' today #12'));
