-- QC-777: reply links on order-notify and status-ping SMS.
-- For $(DriverId) (an active driver with a phone, no live assignment from yesterday on, and a day-shift truck
-- assignment whose truck is the driver's own truck under its vendor) it copies the order of that assignment into a
-- new order (yesterday to tomorrow, one truck needed) and gives the driver five assignments on it, all Fixed with
-- loads so the assignment save that sends the notify SMS validates:
--   today     Accepted 22:00 (the Status Ping lands here: it is the driver's earliest live assignment from today on)
--   accept    tomorrow Pending 06:30 (answered "accept" on its link)
--   cant      tomorrow Pending 09:00 (answered "cant" on its link)
--   withdraw  tomorrow Pending 11:00 (canceled by the spec to withdraw its link)
--   decline   tomorrow Pending 13:00 (QC-894: answered "cant" with a comment on its link)
-- No message is seeded: the spec sends every SMS through the API. Every row is marked E2E-QC777 (order and
-- assignment Notes). Re-running first removes what an earlier run left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC777';
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

DELETE app.MessageReplyLinks
WHERE MessageID_FK IN (SELECT Id FROM @OldMessages) OR AnswerMessageID_FK IN (SELECT Id FROM @OldMessages);
DELETE app.TripNotes WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.OrderAssignmentHistory WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.DispatchScheduleSnapshots WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments);
DELETE app.DriverMirrorChanges
WHERE OrderAssignmentID_FK IN (SELECT Id FROM @OldAssignments) OR MessageID_FK IN (SELECT Id FROM @OldMessages);
DELETE app.Messages WHERE MessageID IN (SELECT Id FROM @OldMessages);
DELETE app.OrderAssignments WHERE OrderAssignmentID IN (SELECT Id FROM @OldAssignments);
DELETE app.Orders WHERE Notes = @Marker;

DECLARE @TemplateAssignmentId int =
(
    SELECT TOP 1 a.OrderAssignmentID
    FROM app.OrderAssignments a
    JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    JOIN app.Jobs j ON j.JobID = o.JobID_FK
    JOIN auth.Users u ON u.Id = a.DriverUserID_FK
    JOIN auth.Organisations t ON t.OrganisationID = a.TruckID_FK
    WHERE a.DriverUserID_FK = @DriverId
      AND a.Active = 1
      AND o.Active = 1
      AND a.AssignmentType = 10
      AND a.TruckID_FK = u.OrganisationIdFk
      AND t.ParentOrganisationIdFk = a.VendorID_FK
      AND j.IsNightShift = 0
    ORDER BY a.AssignmentDate DESC, a.OrderAssignmentID DESC
);

IF @TemplateAssignmentId IS NULL
    THROW 50077, 'The driver has no live truck assignment on a day-shift job, on its own truck, to copy.', 1;

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
OUTPUT CASE inserted.TimeWindowStart
            WHEN '22:00' THEN 'today'
            WHEN '06:30' THEN 'accept'
            WHEN '09:00' THEN 'cant'
            WHEN '11:00' THEN 'withdraw'
            ELSE 'decline' END,
       inserted.OrderAssignmentID
INTO @Seeded (Slot, Id)
SELECT
    @CreatedUtc, @CreatedUtc, 1, @OrderId, a.VendorID_FK, a.DriverUserID_FK, a.TruckID_FK, NULL,
    d.Day, d.StartAt, d.EndAt, ISNULL(NULLIF(a.LoadsAssigned, 0), 3), a.EstimatedTripMins, NULL,
    0, NULL, @Marker, a.AssignmentType, 10, d.Status
FROM app.OrderAssignments a
CROSS JOIN (VALUES
    (1, @Today, CAST('22:00' AS time), CAST('23:30' AS time), 2),
    (2, @Tomorrow, CAST('06:30' AS time), CAST('14:30' AS time), 1),
    (3, @Tomorrow, CAST('09:00' AS time), CAST('15:00' AS time), 1),
    (4, @Tomorrow, CAST('11:00' AS time), CAST('16:00' AS time), 1),
    (5, @Tomorrow, CAST('13:00' AS time), CAST('17:00' AS time), 1)
) AS d (Seq, Day, StartAt, EndAt, Status)
WHERE a.OrderAssignmentID = @TemplateAssignmentId
ORDER BY d.Seq;

COMMIT TRANSACTION;

SELECT CONCAT('SEED order=', @OrderId,
    ';today=', (SELECT Id FROM @Seeded WHERE Slot = 'today'),
    ';accept=', (SELECT Id FROM @Seeded WHERE Slot = 'accept'),
    ';cant=', (SELECT Id FROM @Seeded WHERE Slot = 'cant'),
    ';withdraw=', (SELECT Id FROM @Seeded WHERE Slot = 'withdraw'),
    ';decline=', (SELECT Id FROM @Seeded WHERE Slot = 'decline'),
    ';watermark=', (SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages));
