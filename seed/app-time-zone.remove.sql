-- Removes only the message app-time-zone.apply.sql inserted (matched by its marker body).
SET NOCOUNT ON;

DELETE app.Messages WHERE MessageBody = N'E2E-QC654-TZ-PROBE';
