-- Plan vs Live (QC-658): a midnight plan for 2026-10-05, the local day with real driver assignments.
-- Every live assignment that day gets a snapshot row. The lowest assignment id is planned 90 minutes
-- later than it now runs, so its plan bar overlaps its live bar (Time shifted). The rest are planned
-- exactly as they run (Unchanged). CapturedAt is a fixed marker so remove.sql deletes only these rows.
-- Re-running replaces the rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @BusinessDate date = '2026-10-05';
DECLARE @CapturedAt datetime2 = '2026-10-05T05:00:58.0000000';
DECLARE @ShiftMinutes int = 90;

BEGIN TRANSACTION;

DELETE app.DispatchScheduleSnapshots
WHERE BusinessDate = @BusinessDate AND CapturedAt = @CapturedAt;

DECLARE @ShiftedAssignmentId int =
(
    SELECT MIN(oa.OrderAssignmentID)
    FROM app.OrderAssignments oa
    WHERE oa.AssignmentDate = @BusinessDate
      AND oa.Active = 1
      AND oa.TimeWindowStart IS NOT NULL
      AND oa.TimeWindowEnd IS NOT NULL
);

IF @ShiftedAssignmentId IS NULL
    THROW 50001, 'No live assignment with a time window on 2026-10-05; nothing to seed.', 1;

INSERT app.DispatchScheduleSnapshots
(
    Created, Updated, Active, BusinessDate, CapturedAt,
    OrderID_FK, JobID_FK, OrderFulfillmentType, OrderStatus,
    OrderTimeWindowStart, OrderTimeWindowEnd, OrderTrucksNeeded, OrderLoadsPerTruck, OrderQuantity,
    OrderStartDate, OrderEndDate, AreaID_FK, DispatcherUserID_FK,
    OrderAssignmentID_FK, AssignmentType, RowKey, VendorID_FK, TruckID_FK, DriverUserID_FK,
    TruckCount, LoadsAssigned, FulfillmentType, EstimatedTripMins,
    ScheduledStart, ScheduledEnd, HasTimeWindow, AssignmentStatus
)
SELECT
    SYSUTCDATETIME(), SYSUTCDATETIME(), 1, @BusinessDate, @CapturedAt,
    o.OrderID, o.JobID_FK, o.FulfillmentType, o.OrderStatusID_FK,
    o.TimeWindowStart, o.TimeWindowEnd, o.TrucksNeeded, o.LoadsPerTruck, o.OrderQuantity,
    o.OrderStartDate, o.OrderEndDate, o.AreaID_FK, o.DispatcherUserID_FK,
    oa.OrderAssignmentID, oa.AssignmentType,
    CASE WHEN oa.AssignmentType = 10
         THEN CONCAT('Driver:', oa.TruckID_FK, ':', oa.DriverUserID_FK)
         ELSE CONCAT('Vendor:', oa.VendorID_FK) END,
    oa.VendorID_FK, oa.TruckID_FK, oa.DriverUserID_FK,
    oa.TruckCount, oa.LoadsAssigned, oa.FulfillmentType, oa.EstimatedTripMins,
    CASE WHEN oa.OrderAssignmentID = @ShiftedAssignmentId
         THEN DATEADD(MINUTE, @ShiftMinutes, oa.TimeWindowStart) ELSE oa.TimeWindowStart END,
    CASE WHEN oa.OrderAssignmentID = @ShiftedAssignmentId
         THEN DATEADD(MINUTE, @ShiftMinutes, oa.TimeWindowEnd) ELSE oa.TimeWindowEnd END,
    1,
    oa.OrderAssignmentStatusID_FK
FROM app.OrderAssignments oa
JOIN app.Orders o ON o.OrderID = oa.OrderID_FK
WHERE oa.AssignmentDate = @BusinessDate
  AND oa.Active = 1
  AND oa.TimeWindowStart IS NOT NULL
  AND oa.TimeWindowEnd IS NOT NULL;

COMMIT TRANSACTION;

SELECT OrderAssignmentID_FK, ScheduledStart, ScheduledEnd
FROM app.DispatchScheduleSnapshots
WHERE BusinessDate = @BusinessDate AND CapturedAt = @CapturedAt
ORDER BY OrderAssignmentID_FK;
