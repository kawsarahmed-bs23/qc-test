-- Removes only the messages comms-seen-by.apply.sql inserted (matched by their marker bodies).
SET NOCOUNT ON;

DELETE app.Messages
WHERE MessageBody IN (N'E2E-QC685-SEEN-AUTO', N'E2E-QC685-SEEN-QUEUE', N'E2E-QC685-OUT-READ', N'E2E-QC685-OUT-UNREAD');
