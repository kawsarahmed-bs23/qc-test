-- QC-930: host-side data for the SMS routing cases (tests/app/sms-routing.spec.ts), in the host database (LOCAL_SQL_DATABASE):
--   * a throwaway vendor 'E2E QC-930 Vendor' (short E2E930V) under the host organisation (EnvironmentSetting
--     HostOrganisationId) with an app.VendorSettings row, and three trucks under it, each with an app.TruckSettings row
--     (TruckNumber E2E930L / E2E930P / E2E930Q when the QC-922 column is there): 'E2E QC-930 Truck L', '... Truck P', '... Truck Q',
--   * three host-only Drivers (no Identity rows, no password), one on each truck:
--       linked  e2e.qc930.linked@quarryconnect.test, phone 5125559301, Id and UserUUID $(LinkedId), so the host treats it as a
--               Driver App driver; an app.UserSettings row (MobilePhone 5125559301, NotifyBySms 1, NotifyByPush 0, LanguageCode es),
--       plain   e2e.qc930.plain@quarryconnect.test, phone 5125559302, no UserUUID and no app.UserSettings row (texts on),
--       quiet   e2e.qc930.quiet@quarryconnect.test, phone 5125559303, no UserUUID, app.UserSettings NotifyBySms 0,
--   * one order 'e2e-qc930' (copied job, truck type and dispatcher from the newest real driver assignment) open from today to
--     today + 6 in TimeZoneSettings:TimeZoneId,
--   * one Pending assignment of the plain driver on Truck P today, Notes 'e2e-qc930 edit', for the edit-dialog case. It is
--     written straight to the table, so no offer is sent for it.
-- Prints 'SEEDED vendor=..;truckL=..;truckP=..;truckQ=..;order=..;edit=..'. host-qc930.remove.sql deletes it all, plus the
-- assignments, copies, messages and history the cases make on that order; run it first.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Marker nvarchar(50) = N'e2e-qc930';
DECLARE @LinkedId nvarchar(450) = LOWER(N'$(LinkedId)');
IF TRY_CONVERT(uniqueidentifier, @LinkedId) IS NULL
    THROW 50001, 'LinkedId must be a GUID.', 1;

DECLARE @HostOrganisationId int = TRY_CONVERT(int, (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE PropertyName = N'HostOrganisationId'));
IF @HostOrganisationId IS NULL OR NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @HostOrganisationId)
    THROW 50002, 'The host organisation (EnvironmentSetting HostOrganisationId) is not in auth.Organisations.', 1;

DECLARE @VendorType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Vendor');
DECLARE @TruckType nvarchar(450) = (SELECT TOP 1 LOWER(CONVERT(varchar(50), RoleTypeId)) FROM auth.RoleTypes WHERE RoleType = N'Truck');
IF @VendorType IS NULL OR @TruckType IS NULL
    THROW 50003, 'auth.RoleTypes has no Vendor or Truck row.', 1;

IF EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName LIKE N'E2E QC-930 %')
   OR EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC930.%@QUARRYCONNECT.TEST')
   OR EXISTS (SELECT 1 FROM app.Orders WHERE Notes = @Marker)
    THROW 50004, 'QC-930 data is already there; run host-qc930.remove.sql first.', 1;

DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

DECLARE @JobId int, @TruckTypeId int, @DispatcherUserId nvarchar(450);
SELECT TOP 1 @JobId = o.JobID_FK, @TruckTypeId = o.TruckTypeID_FK, @DispatcherUserId = o.DispatcherUserID_FK
FROM app.OrderAssignments oa
JOIN app.Orders o ON o.OrderID = oa.OrderID_FK
WHERE oa.AssignmentType = 10 AND oa.TruckID_FK IS NOT NULL AND oa.Active = 1 AND o.Active = 1
  AND ISNULL(oa.Notes, N'') NOT LIKE N'e2e%' AND ISNULL(o.Notes, N'') NOT LIKE N'e2e%'
ORDER BY oa.OrderAssignmentID DESC;
IF @JobId IS NULL
    THROW 50005, 'No driver assignment to copy the job, truck type and dispatcher from.', 1;

BEGIN TRANSACTION;

DECLARE @OrgLegacy bit = CASE WHEN COL_LENGTH(N'auth.Organisations', N'IsInvestmentFirm') IS NOT NULL THEN 1 ELSE 0 END;
DECLARE @OrgInsert nvarchar(max) = N'INSERT auth.Organisations (ParentOrganisationIdFk, OrganisationName, OrganisationShortName, CountryClassIdFk, RejectedEULA, RoleTypeIdFk, ReadOnly, UpdatedOn, UpdatedBy, IsActive'
    + CASE WHEN @OrgLegacy = 1 THEN N', IsInvestmentFirm' ELSE N'' END
    + N') VALUES (@Parent, @Name, @Short, 0, 0, @Type, 0, GETUTCDATE(), N''e2e-qc930'', 1'
    + CASE WHEN @OrgLegacy = 1 THEN N', 0' ELSE N'' END + N');';
DECLARE @OrgParams nvarchar(200) = N'@Parent int, @Name nvarchar(100), @Short varchar(20), @Type nvarchar(450)';

EXEC sp_executesql @OrgInsert, @OrgParams, @HostOrganisationId, N'E2E QC-930 Vendor', 'E2E930V', @VendorType;
DECLARE @Vendor int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Vendor');
EXEC sp_executesql @OrgInsert, @OrgParams, @Vendor, N'E2E QC-930 Truck L', 'E2E930L', @TruckType;
EXEC sp_executesql @OrgInsert, @OrgParams, @Vendor, N'E2E QC-930 Truck P', 'E2E930P', @TruckType;
EXEC sp_executesql @OrgInsert, @OrgParams, @Vendor, N'E2E QC-930 Truck Q', 'E2E930Q', @TruckType;
DECLARE @TruckL int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Truck L');
DECLARE @TruckP int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Truck P');
DECLARE @TruckQ int = (SELECT MAX(OrganisationID) FROM auth.Organisations WHERE OrganisationName = N'E2E QC-930 Truck Q');

INSERT app.VendorSettings (OrganisationID_FK, Created, Updated, Active, NeedsSync, QBOrganisationName, BillToUserId_Fk, DispatchContactUserID_FK)
VALUES (@Vendor, GETUTCDATE(), GETUTCDATE(), 1, 0, N'E2E930V', NULL, NULL);

IF COL_LENGTH(N'app.TruckSettings', N'TruckNumber') IS NOT NULL
    EXEC sp_executesql N'INSERT app.TruckSettings (OrganisationID_FK, Created, Updated, Active, TruckTypeID_FK, TruckNumber, VendorID_FK)
        VALUES (@L, GETUTCDATE(), GETUTCDATE(), 1, 0, N''E2E930L'', @V), (@P, GETUTCDATE(), GETUTCDATE(), 1, 0, N''E2E930P'', @V),
               (@Q, GETUTCDATE(), GETUTCDATE(), 1, 0, N''E2E930Q'', @V);',
        N'@L int, @P int, @Q int, @V int', @TruckL, @TruckP, @TruckQ, @Vendor;
ELSE
    INSERT app.TruckSettings (OrganisationID_FK, Created, Updated, Active, TruckTypeID_FK)
    VALUES (@TruckL, GETUTCDATE(), GETUTCDATE(), 1, 0), (@TruckP, GETUTCDATE(), GETUTCDATE(), 1, 0), (@TruckQ, GETUTCDATE(), GETUTCDATE(), 1, 0);

DECLARE @People TABLE (Name nvarchar(20) PRIMARY KEY, Truck int NOT NULL, Phone nvarchar(20) NOT NULL, Linked bit NOT NULL, Id nvarchar(450) NOT NULL);
INSERT @People (Name, Truck, Phone, Linked, Id) VALUES
    (N'linked', @TruckL, N'5125559301', 1, @LinkedId),
    (N'plain', @TruckP, N'5125559302', 0, LOWER(CONVERT(nvarchar(36), NEWID()))),
    (N'quiet', @TruckQ, N'5125559303', 0, LOWER(CONVERT(nvarchar(36), NEWID())));

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT p.Id, CASE WHEN p.Linked = 1 THEN CONVERT(uniqueidentifier, p.Id) END,
       N'e2e.qc930.' + p.Name + N'@quarryconnect.test', UPPER(N'e2e.qc930.' + p.Name + N'@quarryconnect.test'),
       N'e2e.qc930.' + p.Name + N'@quarryconnect.test', UPPER(N'e2e.qc930.' + p.Name + N'@quarryconnect.test'), 1, NULL,
       UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
       p.Phone, 0, 0, 1, 0, N'E2E', N'QC-930 ' + UPPER(LEFT(p.Name, 1)) + SUBSTRING(p.Name, 2, 20),
       SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), p.Truck, 0, 0, 1, 0, 0
FROM @People p;

INSERT auth.UserToRoles (UserId, RoleName) SELECT Id, N'Driver' FROM @People;

INSERT app.UserSettings (UserID_FK, MobilePhone, NotifyBySms, NotifyByPush, LanguageCode, Created, Updated, Active, CreatedBy, UpdatedBy)
SELECT Id, Phone, CASE Name WHEN N'linked' THEN 1 ELSE 0 END, 0, CASE Name WHEN N'linked' THEN N'es' END,
       DATEADD(DAY, -1, GETUTCDATE()), DATEADD(DAY, -1, GETUTCDATE()), 1, @Marker, @Marker
FROM @People WHERE Name IN (N'linked', N'quiet');

INSERT app.Orders
(
    Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded,
    OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK
)
VALUES
(
    GETUTCDATE(), GETUTCDATE(), 1, @JobId, @DispatcherUserId, NULL, @TruckTypeId, 6,
    @Today, DATEADD(DAY, 6, @Today), '06:00', '18:00', 2, 0, @Marker, 10, 2
);
DECLARE @OrderId int = SCOPE_IDENTITY();

DECLARE @PlainId nvarchar(450) = (SELECT Id FROM @People WHERE Name = N'plain');
INSERT app.OrderAssignments
(
    Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, AssignmentDate, TimeWindowStart, TimeWindowEnd,
    LoadsAssigned, NotificationSent, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK, OrderAssignmentUUID
)
VALUES (GETUTCDATE(), GETUTCDATE(), 1, @OrderId, @Vendor, @PlainId, @TruckP, @Today, '06:00', '18:00',
        2, 0, @Marker + N' edit', 10, 10, 1, NEWID());
DECLARE @EditId int = SCOPE_IDENTITY();

COMMIT TRANSACTION;

SELECT CONCAT('SEEDED vendor=', @Vendor, ';truckL=', @TruckL, ';truckP=', @TruckP, ';truckQ=', @TruckQ, ';order=', @OrderId, ';edit=', @EditId);
