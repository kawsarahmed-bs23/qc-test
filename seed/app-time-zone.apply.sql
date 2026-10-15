-- QC-654: one message at a fixed UTC instant, so a test can check the time Communications shows.
-- 2026-10-05 10:49:35 UTC is 5:49 AM in Central (CDT) and 4:49 PM in Dhaka. It copies the driver,
-- assignment, direction and type of the newest existing driver message, so it renders like a real one.
-- The body is a fixed marker; remove.sql deletes by it. Re-running replaces the row.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC654-TZ-PROBE';
DECLARE @CreatedUtc datetime = '2026-10-05T10:49:35';

BEGIN TRANSACTION;

DELETE app.Messages WHERE MessageBody = @Marker;

DECLARE @TemplateId int =
(
    SELECT TOP 1 m.MessageID
    FROM app.Messages m
    WHERE m.Active = 1 AND m.DriverUserID_FK IS NOT NULL
    ORDER BY m.Created DESC
);

IF @TemplateId IS NULL
    THROW 50002, 'No driver message to copy; nothing to seed.', 1;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK,
    MessageBody, PhoneNumber, SentAt, IsActioned, Direction, MessageType
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, t.OrderAssignmentID_FK, t.DriverUserID_FK, t.VendorID_FK,
    @Marker, t.PhoneNumber, @CreatedUtc, 0, t.Direction, t.MessageType
FROM app.Messages t
WHERE t.MessageID = @TemplateId;

DECLARE @MessageId int = SCOPE_IDENTITY();
DECLARE @DriverId nvarchar(450) = (SELECT DriverUserID_FK FROM app.Messages WHERE MessageID = @MessageId);

COMMIT TRANSACTION;

PRINT CONCAT('SEED message=', @MessageId, ';driver=', @DriverId, ';createdUtc=2026-10-05T10:49:35Z');
