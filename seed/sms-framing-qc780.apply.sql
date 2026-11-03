-- QC-780: dispatch SMS framing. The spec texts two existing active drivers who have live assignments and no outbound
-- SMS with SentAt to their phone, so their first text is framed ("<HostName>: ...\nReply STOP to opt out").
-- This script changes no existing row: it deletes messages a failed earlier run may have left (bodies containing
-- E2E-QC780) and prints the highest MessageID, which the spec keeps as its watermark. Every message the spec creates
-- (manual sends carry the marker; Status Pings do not) has a higher MessageID and belongs to $(SmsDriverId) or
-- $(InAppDriverId); sms-framing-qc780.remove.sql deletes exactly those, together with any SentAt the spec backdated
-- on them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC780';
DECLARE @SmsDriverId nvarchar(450) = N'$(SmsDriverId)';
DECLARE @InAppDriverId nvarchar(450) = N'$(InAppDriverId)';

IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Id = @SmsDriverId AND IsActive = 1 AND ISNULL(PhoneNumber, '') <> '')
    THROW 50001, 'The SMS driver must be an active user with a phone number.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Id = @InAppDriverId AND IsActive = 1)
    THROW 50002, 'The in-app driver must be an active user.', 1;

BEGIN TRANSACTION;

DELETE app.Messages WHERE MessageBody LIKE N'%' + @Marker + N'%';

COMMIT TRANSACTION;

DECLARE @After int = (SELECT ISNULL(MAX(MessageID), 0) FROM app.Messages);
PRINT CONCAT('SEED after=', @After);
