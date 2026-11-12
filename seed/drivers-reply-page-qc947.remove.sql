-- QC-948: removes what drivers-reply-page-qc947.apply.sql and the reply-page cases left in DRIVERS_SQL_DATABASE: the
-- 'E2E-QC947-RP <slot>' assignments with every message in their threads and any message whose body starts 'E2E-QC947-RP ', the 'You replied STOP/START' notices for
-- $(DriverUuid) newer than message $(AfterMessageId), and the e2e-qc947 driver-host links.
-- Prints 'REMOVED assignments=0;messages=0;links=0' when nothing is left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DriverUuid uniqueidentifier = N'$(DriverUuid)';
DECLARE @AfterMessageId int = $(AfterMessageId);

DECLARE @Assignments TABLE (Id uniqueidentifier PRIMARY KEY);
INSERT @Assignments SELECT OrderAssignmentUUID FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC947-RP %';

BEGIN TRANSACTION;

DELETE app.Messages
WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments)
   OR MessageBody LIKE N'%E2E-QC947-RP %'
   OR (DriverUserUUID = @DriverUuid AND MessageID > @AfterMessageId AND MessageType = 50
       AND (MessageBody LIKE N'You replied STOP.%' OR MessageBody LIKE N'You replied START.%'));
DELETE app.OrderAssignments WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments);
DELETE app.DriverHostLinks WHERE CreatedBy = N'e2e-qc947';

COMMIT TRANSACTION;

DECLARE @LeftAssignments int = (SELECT COUNT(*) FROM app.OrderAssignments WHERE Notes LIKE N'E2E-QC947-RP %');
DECLARE @LeftMessages int = (SELECT COUNT(*) FROM app.Messages WHERE OrderAssignmentUUID IN (SELECT Id FROM @Assignments));
DECLARE @LeftLinks int = (SELECT COUNT(*) FROM app.DriverHostLinks WHERE CreatedBy = N'e2e-qc947');
PRINT CONCAT(N'REMOVED assignments=', @LeftAssignments, N';messages=', @LeftMessages, N';links=', @LeftLinks);
