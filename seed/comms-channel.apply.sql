-- QC-630: message channel (SMS / In-App) and unmatched inbound SMS on the Communications page.
-- Gives the newest driver who has ever been messaged a Running assignment today, copied from their
-- latest assignment, so the composer and Status Ping are enabled. Adds one outbound message on each
-- channel to that driver's thread, and one inbound SMS from a number no user has, so it lands in the
-- queue unmatched. Everything is marked (assignment Notes, message bodies starting E2E-QC630) and
-- remove.sql deletes by those markers. Re-running replaces the rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC630';
DECLARE @UnmatchedPhone varchar(20) = '+15550100630';
DECLARE @CreatedUtc datetime = DATEADD(MINUTE, -3, GETUTCDATE());
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date);

BEGIN TRANSACTION;

DELETE app.Messages
WHERE MessageBody LIKE @Marker + N'%'
   OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = @Marker);

DELETE app.OrderAssignments WHERE Notes = @Marker;

DECLARE @DriverId nvarchar(450) =
(
    SELECT TOP 1 m.DriverUserID_FK
    FROM app.Messages m
    WHERE m.Active = 1 AND m.DriverUserID_FK IS NOT NULL
    ORDER BY m.Created DESC
);

IF @DriverId IS NULL
    THROW 50002, 'No driver has ever been messaged; nothing to seed.', 1;

DECLARE @TemplateAssignmentId int =
(
    SELECT TOP 1 a.OrderAssignmentID
    FROM app.OrderAssignments a
    WHERE a.DriverUserID_FK = @DriverId AND a.Active = 1
    ORDER BY a.AssignmentDate DESC, a.OrderAssignmentID DESC
);

IF @TemplateAssignmentId IS NULL
    THROW 50003, 'That driver has no assignment to copy.', 1;

INSERT app.OrderAssignments
(
    Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, TruckCount,
    AssignmentDate, TimeWindowStart, TimeWindowEnd, LoadsAssigned, EstimatedTripMins, ActualAvgTripMins,
    NotificationSent, NotificationSentAt, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, a.OrderID_FK, a.VendorID_FK, a.DriverUserID_FK, a.TruckID_FK, a.TruckCount,
    @Today, a.TimeWindowStart, a.TimeWindowEnd, a.LoadsAssigned, a.EstimatedTripMins, NULL,
    0, NULL, @Marker, a.AssignmentType, a.FulfillmentType, 4
FROM app.OrderAssignments a
WHERE a.OrderAssignmentID = @TemplateAssignmentId;

DECLARE @AssignmentId int = SCOPE_IDENTITY();

DECLARE @DriverPhone varchar(20) =
(
    SELECT TOP 1 m.PhoneNumber
    FROM app.Messages m
    WHERE m.DriverUserID_FK = @DriverId AND m.PhoneNumber IS NOT NULL
    ORDER BY m.Created DESC
);

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK,
    MessageBody, PhoneNumber, SentAt, IsActioned, Direction, MessageType, Channel
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, a.OrderAssignmentID, a.DriverUserID_FK, a.VendorID_FK,
    v.Body, @DriverPhone, @CreatedUtc, 1, 20, 30, v.Channel
FROM app.OrderAssignments a
CROSS JOIN (VALUES
    (@Marker + N'-OUT-SMS', 10),
    (@Marker + N'-OUT-INAPP', 20)
) v(Body, Channel)
WHERE a.OrderAssignmentID = @AssignmentId;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK,
    MessageBody, PhoneNumber, IsActioned, Direction, MessageType, Channel, AiClassification, AiConfidence
)
VALUES
(
    @CreatedUtc, @CreatedUtc, 1, NULL, NULL, NULL,
    @Marker + N'-UNMATCHED', @UnmatchedPhone, 0, 10, 40, 10, 50, 30
);

DECLARE @SmsId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @Marker + N'-OUT-SMS');
DECLARE @InAppId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @Marker + N'-OUT-INAPP');
DECLARE @UnmatchedId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @Marker + N'-UNMATCHED');

COMMIT TRANSACTION;

PRINT CONCAT('SEED sms=', @SmsId, ';inApp=', @InAppId, ';unmatched=', @UnmatchedId,
    ';assignment=', @AssignmentId, ';driver=', @DriverId);
