-- QC-937: the DRIVERS side (DRIVERS_SQL_DATABASE) of the linked driver in tests/app/reply-confirmation.spec.ts, the way a Host
-- invite acceptance leaves it, plus its pending offers:
--   * an auth.Organisations row 'E2E QC-937 Driver' (Driver role type), an auth.Users row (Id a new GUID string, UserUUID $(UserId),
--     e2e.qc937.linked@quarryconnect.test, phone 5125559372, active), the Driver role, an app.DriverSettings row with NotifyBySms 1,
--     and an active app.DriverHostLinks row to $(HostUuid) (CreatedBy 'e2e-qc937', SmsOptedOut 0, marked as synced);
--   * for each 'linked' entry of $(Rows) ('slot,codeHash,assignmentUuid,messageUuid,who;...', the list the host seed took): a
--     Pending assignment today in app time (Notes 'E2E-QC937-RC <slot>', JobDocNameWithPrefix $(JobDoc)) and the dispatch
--     offer message messageUuid (IsFromDispatch 1, MessageType 30), so the same uuids exist in both databases.
-- It does not touch app.Hosts: the spec sets and restores SmsFromNumber / ReplyConfirmation itself.
-- drivers-qc937.remove.sql deletes it all.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF COL_LENGTH(N'app.DriverSettings', N'NotifyBySms') IS NULL OR COL_LENGTH(N'app.Hosts', N'ReplyConfirmation') IS NULL
    THROW 50001, 'The QC-930 / QC-937 DRIVERS migrations (NotifyBySms, SmsFromNumber, ReplyConfirmation) are not applied.', 1;

DECLARE @UserUuid uniqueidentifier = CONVERT(uniqueidentifier, N'$(UserId)');
DECLARE @HostUuid uniqueidentifier = (SELECT HostUUID FROM app.Hosts WHERE HostUUID = CONVERT(uniqueidentifier, N'$(HostUuid)') AND Active = 1);
DECLARE @JobDoc nvarchar(100) = N'$(JobDoc)';
DECLARE @Rows nvarchar(max) = N'$(Rows)';
IF @HostUuid IS NULL
    THROW 50002, 'The host is not an active host in the drivers database.', 1;

DECLARE @RoleTypeId varchar(100) = UPPER(CONVERT(varchar(36), (SELECT RoleTypeId FROM auth.RoleTypes WHERE RoleType = N'Driver')));
DECLARE @RoleId nvarchar(450) = (SELECT Id FROM auth.Roles WHERE NormalizedName = N'DRIVER');
IF @RoleTypeId IS NULL OR @RoleId IS NULL
    THROW 50003, 'The Driver role type or role is missing.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE UserUUID = @UserUuid) OR EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationName = N'E2E QC-937 Driver')
    THROW 50004, 'The QC-937 driver is already there; run drivers-qc937.remove.sql first.', 1;

DECLARE @Seeds TABLE (Seq int IDENTITY PRIMARY KEY, Slot nvarchar(20), AssignmentUuid uniqueidentifier, MessageUuid uniqueidentifier);
INSERT @Seeds (Slot, AssignmentUuid, MessageUuid)
SELECT JSON_VALUE(j, '$[0]'), CAST(JSON_VALUE(j, '$[2]') AS uniqueidentifier), CAST(JSON_VALUE(j, '$[3]') AS uniqueidentifier)
FROM (SELECT N'["' + REPLACE(LTRIM(RTRIM(value)), N',', N'","') + N'"]' AS j FROM STRING_SPLIT(@Rows, N';') WHERE LTRIM(RTRIM(value)) <> N'') r
WHERE JSON_VALUE(j, '$[4]') = N'linked';

BEGIN TRANSACTION;

INSERT auth.Organisations (OrganisationName, OrganisationShortName, CountryClassIdFk, RoleTypeIdFk, UpdatedOn, UpdatedBy, IsActive)
VALUES (N'E2E QC-937 Driver', 'E937', 0, @RoleTypeId, GETUTCDATE(), 'e2e-qc937', 1);
DECLARE @OrganisationId int = SCOPE_IDENTITY();

DECLARE @Id nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT auth.Users (Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, FirstName, LastName, PhoneNumber, OrganisationIdFk, CreateDate, IsActive)
VALUES (@Id, @UserUuid, N'e2e.qc937.linked@quarryconnect.test', N'E2E.QC937.LINKED@QUARRYCONNECT.TEST', N'e2e.qc937.linked@quarryconnect.test',
        N'E2E.QC937.LINKED@QUARRYCONNECT.TEST', N'E2E', N'QC-937 Linked', N'5125559372', @OrganisationId, SYSDATETIMEOFFSET(), 1);
INSERT auth.UserToRoles (UserId, RoleId) VALUES (@Id, @RoleId);
INSERT app.DriverSettings (OrganisationID_FK, TruckNumber, NotifyBySms, ContactVersion, CreatedBy, UpdatedBy)
VALUES (@OrganisationId, NULL, 1, NULL, N'e2e-qc937', N'e2e-qc937');
INSERT app.DriverHostLinks (UserUUID, HostUUID, DriverName, SyncRequestedAt, SyncedAt, CreatedBy, UpdatedBy)
VALUES (@UserUuid, @HostUuid, N'E2E QC-937 Linked', GETUTCDATE(), GETUTCDATE(), N'e2e-qc937', N'e2e-qc937');

DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE N'Central Standard Time' AS date);
INSERT app.OrderAssignments
    (HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, LoadsAssigned, FulfillmentType, Notes,
     JobDocNameWithPrefix, Origin, Destination, MaterialName, CanUploadTickets, CreatedBy, UpdatedBy)
SELECT @HostUuid, @UserUuid, AssignmentUuid, 1, @Today, 1, 2, 10, N'E2E-QC937-RC ' + Slot,
       @JobDoc, N'E2E QC-937 Quarry', N'E2E QC-937 Site', N'E2E Gravel', 0, N'e2e-qc937', N'e2e-qc937'
FROM @Seeds;
INSERT app.Messages
    (HostUUID, DriverUserUUID, MessageUUID, OrderAssignmentUUID, Version, IsFromDispatch, MessageType, MessageBody, SentAt, Created, Updated, Active, CreatedBy, UpdatedBy)
SELECT @HostUuid, @UserUuid, MessageUuid, AssignmentUuid, 1, 1, 30, N'E2E-QC937-RC ' + Slot + N' message', GETUTCDATE(), GETUTCDATE(), GETUTCDATE(), 1, N'e2e-qc937', N'e2e-qc937'
FROM @Seeds;

COMMIT TRANSACTION;

SELECT CONCAT('SEEDED drivers user=', @Id, ';slots=', (SELECT COUNT(*) FROM @Seeds));
