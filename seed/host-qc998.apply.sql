-- QC-998: one throwaway order for tests/drivers/host-change-sync.spec.ts, copied from order $(SourceOrder) (its Job,
-- truck type, unit and dispatcher) with Notes 'e2e-qc998 order', running from $(Today) for four days and New, so
-- dispatch can assign the QC-933 throwaway driver to it today and tomorrow. host-qc998.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Today date = '$(Today)';
DECLARE @Made TABLE (OrderID int);

IF EXISTS (SELECT 1 FROM app.Orders WHERE Notes = N'e2e-qc998 order')
    THROW 50001, 'QC-998 data is already there; run host-qc998.remove.sql first.', 1;

BEGIN TRANSACTION;

INSERT app.Orders (Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, OrderStartDate, OrderEndDate,
                   TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, IsQuote, Notes, FulfillmentType, OrderQuantity, UnitID_FK,
                   OrderStatusID_FK, OrderUUID)
OUTPUT inserted.OrderID INTO @Made (OrderID)
SELECT GETUTCDATE(), GETUTCDATE(), 1, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, @Today, DATEADD(day, 3, @Today),
       TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, 0, N'e2e-qc998 order', FulfillmentType, OrderQuantity, UnitID_FK,
       1, NEWID()
FROM app.Orders
WHERE OrderID = $(SourceOrder);

COMMIT TRANSACTION;

SELECT CONCAT('ORDER:', MIN(OrderID)) FROM @Made;
