-- Puts back the truck type orders-grid-qc828.apply.sql replaced. Variables: OrderId, OriginalTruckTypeId.
SET NOCOUNT ON;

UPDATE app.Orders SET TruckTypeID_FK = $(OriginalTruckTypeId) WHERE OrderID = $(OrderId);
