-- QC-804: the Communications send gate is gone; any active driver can be messaged.
-- Gives $(PlannedDriverId) a Pending assignment dated tomorrow (copied from their latest live assignment), so their
-- nearest assignment is a future one, and sets $(InactiveDriverId) to IsActive = 0. The spec reads that driver's
-- original IsActive first and comms-gate-qc804.remove.sql puts it back. Rows are marked E2E-QC804 (assignment Notes,
-- message bodies). Re-running replaces the assignment.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(100) = N'E2E-QC804';
DECLARE @PlannedDriverId nvarchar(450) = N'$(PlannedDriverId)';
DECLARE @InactiveDriverId nvarchar(450) = N'$(InactiveDriverId)';
DECLARE @CreatedUtc datetime = GETUTCDATE();
DECLARE @Tomorrow date = DATEADD(DAY, 1, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date));

BEGIN TRANSACTION;

DELETE app.Messages
WHERE MessageBody LIKE @Marker + N'%'
   OR OrderAssignmentID_FK IN (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE Notes = @Marker);

DELETE app.OrderAssignments WHERE Notes = @Marker;

DECLARE @TemplateAssignmentId int =
(
    SELECT TOP 1 a.OrderAssignmentID
    FROM app.OrderAssignments a
    JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    WHERE a.DriverUserID_FK = @PlannedDriverId
      AND a.Active = 1
      AND o.Active = 1
      AND a.OrderAssignmentStatusID_FK NOT IN (8, 9)
    ORDER BY a.AssignmentDate DESC, a.OrderAssignmentID DESC
);

IF @TemplateAssignmentId IS NULL
    THROW 50041, 'The planned driver has no live assignment to copy.', 1;

INSERT app.OrderAssignments
(
    Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, TruckCount,
    AssignmentDate, TimeWindowStart, TimeWindowEnd, LoadsAssigned, EstimatedTripMins, ActualAvgTripMins,
    NotificationSent, NotificationSentAt, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK
)
SELECT
    @CreatedUtc, @CreatedUtc, 1, a.OrderID_FK, a.VendorID_FK, a.DriverUserID_FK, a.TruckID_FK, a.TruckCount,
    @Tomorrow, a.TimeWindowStart, a.TimeWindowEnd, a.LoadsAssigned, a.EstimatedTripMins, NULL,
    0, NULL, @Marker, a.AssignmentType, a.FulfillmentType, 1
FROM app.OrderAssignments a
WHERE a.OrderAssignmentID = @TemplateAssignmentId;

DECLARE @AssignmentId int = SCOPE_IDENTITY();

UPDATE auth.Users SET IsActive = 0 WHERE Id = @InactiveDriverId;

COMMIT TRANSACTION;

PRINT CONCAT('SEED assignment=', @AssignmentId, ';template=', @TemplateAssignmentId);
