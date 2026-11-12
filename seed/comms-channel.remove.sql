-- Removes what comms-channel.apply.sql inserted, plus any message the QC-630 tests sent on the
-- seeded assignment (matched by the E2E-QC630 marker in bodies and the assignment's Notes).
-- The reply links of those messages (a Status Ping gets one) go first.
SET NOCOUNT ON;

DELETE app.MessageReplyLinks
WHERE MessageID_FK IN (SELECT MessageID FROM app.Messages WHERE MessageBody LIKE N'E2E-QC630%'
    OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = N'E2E-QC630'));

DELETE app.Messages
WHERE MessageBody LIKE N'E2E-QC630%'
   OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = N'E2E-QC630');

DELETE app.OrderAssignments WHERE Notes = N'E2E-QC630';
