-- Removes what comms-gate-qc804.apply.sql added and every message the QC-804 tests sent (bodies containing E2E-QC804, which since QC-780 a first SMS carries after the host name,
-- or linked to the seeded assignment), and puts back the original IsActive of $(InactiveDriverId) and the original
-- phone number of $(UnreachableDriverId) that the spec read before it changed them. The reply links of those messages (a Status
-- Ping gets one) go first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

DELETE app.MessageReplyLinks
WHERE MessageID_FK IN (SELECT MessageID FROM app.Messages WHERE MessageBody LIKE N'%E2E-QC804%'
    OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = N'E2E-QC804'));

DELETE app.Messages
WHERE MessageBody LIKE N'%E2E-QC804%'
   OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = N'E2E-QC804');

DELETE app.OrderAssignments WHERE Notes = N'E2E-QC804';

UPDATE auth.Users SET IsActive = $(InactiveIsActive) WHERE Id = N'$(InactiveDriverId)';

UPDATE auth.Users SET PhoneNumber = NULLIF(N'$(UnreachablePhone)', N'') WHERE Id = N'$(UnreachableDriverId)';

COMMIT TRANSACTION;
