-- DFLOW (host API): the data the driver flows spec (tests/drivers/driver-flows.spec.ts) needs on the host: a throwaway vendor
-- organisation 'E2E DFLOW Vendor' (role type Vendor) under the host organisation (EnvironmentSetting HostOrganisationId) with one
-- truck 'E2E DFLOW Truck' (role type Truck), and a copy of order $(SourceOrder) of the local copy (same job, dispatcher, area, truck
-- type and unit) with Notes 'e2e-dflow order', status New and a date range from $(Today) to the day after.
-- Prints IDS:<orderId>,<vendorId>,<truckId>. seed/host-dflow.remove.sql deletes all of it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Today date = '$(Today)';
DECLARE @VendorName nvarchar(200) = N'E2E DFLOW Vendor';
DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType varchar(50) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-dflow'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, @VendorName, 'E2EDFV', @VendorType;
DECLARE @VendorId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @HostOrganisationId AND OrganisationName = @VendorName);
EXEC sp_executesql @OrgInsert, @OrgParams, @VendorId, N'E2E DFLOW Truck', 'E2EDFT', @TruckType;
DECLARE @TruckId int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE ParentOrganisationIdFk = @VendorId AND OrganisationName = N'E2E DFLOW Truck');

DECLARE @Made TABLE (OrderID int);
INSERT app.Orders (Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, OrderStartDate, OrderEndDate,
                   TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, IsQuote, Notes, FulfillmentType, OrderQuantity, UnitID_FK,
                   OrderStatusID_FK, OrderUUID)
OUTPUT inserted.OrderID INTO @Made (OrderID)
SELECT GETUTCDATE(), GETUTCDATE(), 1, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, @Today, DATEADD(day, 1, @Today),
       TimeWindowStart, TimeWindowEnd, LoadsPerTruck, EstimatedTripMins, 0, N'e2e-dflow order', FulfillmentType, OrderQuantity, UnitID_FK,
       1, NEWID()
FROM app.Orders
WHERE OrderID = $(SourceOrder);

COMMIT TRANSACTION;

SELECT CONCAT('IDS:', (SELECT MAX(OrderID) FROM @Made), ',', @VendorId, ',', @TruckId);
