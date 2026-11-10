-- QC-828: gives one order a long truck type so the Dispatch Orders grid has a "Lightweight End Dump" pill to measure.
-- Variables: OrderId, TruckTypeId. Prints the order's original truck type; orders-grid-qc828.remove.sql puts it back.
-- Only TruckTypeID_FK changes, so Updated and every other column stay as they were.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @OrderId int = $(OrderId);
DECLARE @TruckTypeId int = $(TruckTypeId);
DECLARE @Original int = (SELECT TruckTypeID_FK FROM app.Orders WHERE OrderID = @OrderId);

IF @Original IS NULL
    THROW 50002, 'The order to seed does not exist or has no truck type.', 1;

IF NOT EXISTS (SELECT 1 FROM app.List_TruckTypes WHERE TruckTypeID = @TruckTypeId AND Active = 1)
    THROW 50003, 'The truck type to seed does not exist or is inactive.', 1;

UPDATE app.Orders SET TruckTypeID_FK = @TruckTypeId WHERE OrderID = @OrderId;

PRINT CONCAT('SEED order=', @OrderId, ';original=', @Original);
