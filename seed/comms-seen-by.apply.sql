-- QC-685: read receipts in the Communications thread, one row per state.
-- Inbound, already seen by a dispatcher: one actioned (auto-handled bubble), one not (Needs Review).
-- Outbound: one the driver has read, one unread (gray tick: "Not seen yet" or "No read receipt (SMS)").
-- All are dated now so they land in today's thread. They copy the driver, assignment and type of the
-- newest existing driver message, and the dispatcher of the newest existing seen inbound message.
-- The bodies are fixed markers; remove.sql deletes by them. Re-running replaces the rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @AutoMarker nvarchar(100) = N'E2E-QC685-SEEN-AUTO';
DECLARE @QueueMarker nvarchar(100) = N'E2E-QC685-SEEN-QUEUE';
DECLARE @OutReadMarker nvarchar(100) = N'E2E-QC685-OUT-READ';
DECLARE @OutUnreadMarker nvarchar(100) = N'E2E-QC685-OUT-UNREAD';
DECLARE @CreatedUtc datetime = DATEADD(MINUTE, -2, GETUTCDATE());
DECLARE @SeenUtc datetime = DATEADD(MINUTE, -1, GETUTCDATE());

BEGIN TRANSACTION;

DELETE app.Messages WHERE MessageBody IN (@AutoMarker, @QueueMarker, @OutReadMarker, @OutUnreadMarker);

DECLARE @TemplateId int =
(
    SELECT TOP 1 m.MessageID
    FROM app.Messages m
    WHERE m.Active = 1 AND m.DriverUserID_FK IS NOT NULL
    ORDER BY m.Created DESC
);

DECLARE @DispatcherId nvarchar(450) =
(
    SELECT TOP 1 m.SeenByDispatcherUserID
    FROM app.Messages m
    WHERE m.SeenByDispatcherUserID IS NOT NULL
    ORDER BY m.SeenByDispatcherAt DESC
);

IF @TemplateId IS NULL
    THROW 50002, 'No driver message to copy; nothing to seed.', 1;

IF @DispatcherId IS NULL
    THROW 50003, 'No message has ever been seen by a dispatcher; no dispatcher to copy.', 1;

INSERT app.Messages
(
    Created, Updated, Active, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK,
    MessageBody, PhoneNumber, SentAt, IsActioned, Direction, MessageType,
    SeenByDispatcherAt, SeenByDispatcherUserID, SeenByDriverAt
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, t.OrderAssignmentID_FK, t.DriverUserID_FK, t.VendorID_FK,
    v.Body, t.PhoneNumber, @CreatedUtc, v.IsActioned, v.Direction, t.MessageType,
    CASE WHEN v.Direction = 10 THEN @SeenUtc END,
    CASE WHEN v.Direction = 10 THEN @DispatcherId END,
    CASE WHEN v.DriverRead = 1 THEN @SeenUtc END
FROM app.Messages t
CROSS JOIN (VALUES
    (@AutoMarker, 1, 10, 0),
    (@QueueMarker, 0, 10, 0),
    (@OutReadMarker, 1, 20, 1),
    (@OutUnreadMarker, 1, 20, 0)
) v(Body, IsActioned, Direction, DriverRead)
WHERE t.MessageID = @TemplateId;

DECLARE @DriverId nvarchar(450) = (SELECT DriverUserID_FK FROM app.Messages WHERE MessageID = @TemplateId);
DECLARE @AutoId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @AutoMarker);
DECLARE @QueueId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @QueueMarker);
DECLARE @OutReadId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @OutReadMarker);
DECLARE @OutUnreadId int = (SELECT MessageID FROM app.Messages WHERE MessageBody = @OutUnreadMarker);

COMMIT TRANSACTION;

PRINT CONCAT('SEED auto=', @AutoId, ';queue=', @QueueId, ';outRead=', @OutReadId, ';outUnread=', @OutUnreadId, ';driver=', @DriverId);
