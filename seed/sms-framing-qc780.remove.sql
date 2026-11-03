-- QC-780: removes every message the SMS framing spec created: rows after the watermark $(AfterMessageId) that belong to
-- $(SmsDriverId) or $(InAppDriverId) (manual sends, replies and Status Pings, including any whose SentAt the spec
-- backdated), and any row whose body contains E2E-QC780. No other row was changed by the spec.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @AfterMessageId int = $(AfterMessageId);
DECLARE @SmsDriverId nvarchar(450) = N'$(SmsDriverId)';
DECLARE @InAppDriverId nvarchar(450) = N'$(InAppDriverId)';

BEGIN TRANSACTION;

DELETE app.Messages
WHERE MessageBody LIKE N'%E2E-QC780%'
   OR (MessageID > @AfterMessageId AND DriverUserID_FK IN (@SmsDriverId, @InAppDriverId));

COMMIT TRANSACTION;

DECLARE @Left int = (SELECT COUNT(*) FROM app.Messages WHERE MessageBody LIKE N'%E2E-QC780%'
    OR (MessageID > @AfterMessageId AND DriverUserID_FK IN (@SmsDriverId, @InAppDriverId)));
PRINT CONCAT('REMOVED left=', @Left);
