-- QC-931: removes what the AVAIL cases left in DRIVERS_SQL_DATABASE: every availability message (MessageType 60, 70, 80) for
-- $(DriverIds) (comma-separated UserUUIDs) newer than message $(AfterMessageId), with the app's send-message commands for them.
-- Prints 'REMOVED messages=0'.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @After int = $(AfterMessageId);
DECLARE @Drivers TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Drivers SELECT TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) FROM STRING_SPLIT(N'$(DriverIds)', N',') WHERE TRY_CONVERT(uniqueidentifier, LTRIM(RTRIM(value))) IS NOT NULL;

DECLARE @Messages TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Messages SELECT MessageUUID FROM app.Messages WHERE MessageID > @After AND MessageType IN (60, 70, 80) AND DriverUserUUID IN (SELECT Id FROM @Drivers);

BEGIN TRANSACTION;
DELETE app.DriverCommands WHERE TargetUUID IN (SELECT Id FROM @Messages);
DELETE app.Messages WHERE MessageUUID IN (SELECT Id FROM @Messages);
COMMIT TRANSACTION;

DECLARE @Left int = (SELECT COUNT(*) FROM app.Messages WHERE MessageUUID IN (SELECT Id FROM @Messages));
PRINT CONCAT(N'REMOVED messages=', @Left);
