-- QC-873 (host API): two throwaway orders for tests/drivers/ticket-submit.spec.ts, copies of orders $(SourceOrderA) and
-- $(SourceOrderB) of the local copy (same job, dispatcher, area, truck type and unit) with Notes 'e2e-qc873 order', status
-- New and a date range from $(Today) to the day after, so an assignment for host-today passes "The assignment date must
-- fall inside the order's date range." Prints ORDERS:<a>,<b>. seed/host-qc873.remove.sql deletes them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Today date = '$(Today)';
DECLARE @Made TABLE (Source int, OrderID int);

BEGIN TRANSACTION;

INSERT app.Orders (Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, OrderStartDate, OrderEndDate,
                   TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, IsQuote, Notes, FulfillmentType, OrderQuantity, UnitID_FK,
                   OrderStatusID_FK, OrderUUID)
OUTPUT inserted.OrderID INTO @Made (OrderID)
SELECT GETUTCDATE(), GETUTCDATE(), 1, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, @Today, DATEADD(day, 1, @Today),
       TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, 0, N'e2e-qc873 order', FulfillmentType, OrderQuantity, UnitID_FK,
       1, NEWID()
FROM app.Orders
WHERE OrderID IN ($(SourceOrderA), $(SourceOrderB))
ORDER BY OrderID;

COMMIT TRANSACTION;

SELECT CONCAT('ORDERS:', STRING_AGG(CAST(OrderID AS varchar(12)), ',') WITHIN GROUP (ORDER BY OrderID)) FROM @Made;
