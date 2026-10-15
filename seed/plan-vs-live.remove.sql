-- Removes only the rows plan-vs-live.apply.sql inserted (matched by its CapturedAt marker).
SET NOCOUNT ON;

DELETE app.DispatchScheduleSnapshots
WHERE BusinessDate = '2026-10-05'
  AND CapturedAt = '2026-10-05T05:00:58.0000000';
