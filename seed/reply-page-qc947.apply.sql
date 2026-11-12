-- QC-947: reply-page rows for the driver $(DriverId) in the host database (LOCAL_SQL_DATABASE), without sending anything.
-- $(Rows) lists the rows to add, separated by ';', each 'slot,type,codeHash,assignmentUuid,messageUuid,state':
--   type      10 (OrderNotify, a job offer, assignment Pending) or 20 (StatusCheck, assignment Accepted)
--   codeHash  the lowercase SHA-256 of the 10-character link code the test made; the code itself is never stored
--   state     open, expired (ExpiresAt an hour ago), withdrawn (assignment Canceled) or app (already answered Accept in the app)
-- Each slot gets an assignment copied from the newest assignment of $(TemplateDriverId) not made by an e2e seed (job,
-- vendor, truck and times), dated today in app time, with Notes 'E2E-QC947-RP <slot>'; an outbound SMS from dispatch
-- with body 'E2E-QC947-RP <slot> message'; and its MessageReplyLinks row.
-- When $(DriverEmail) is not '-', it first adds a host user with that email, the Id $(DriverId) (UserUUID the same), the
-- Driver role and the phone $(DriverPhone), in the template driver's organisation. reply-page-qc947.remove.sql deletes it all.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DriverId nvarchar(450) = N'$(DriverId)';
DECLARE @TemplateDriverId nvarchar(450) = N'$(TemplateDriverId)';
DECLARE @DriverEmail nvarchar(256) = N'$(DriverEmail)';
DECLARE @DriverPhone nvarchar(20) = N'$(DriverPhone)';
DECLARE @Rows nvarchar(max) = N'$(Rows)';
DECLARE @Marker nvarchar(50) = N'E2E-QC947-RP';
DECLARE @Now datetime = GETUTCDATE();
DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

IF @DriverEmail <> N'-' AND @DriverEmail NOT LIKE N'e2e.qc947.%@quarryconnect.test'
    THROW 50001, 'The throwaway driver email must start with e2e.qc947. and end with @quarryconnect.test.', 1;

DECLARE @TemplateId int = (
    SELECT TOP 1 a.OrderAssignmentID FROM app.OrderAssignments a
    WHERE a.DriverUserID_FK = @TemplateDriverId AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL
      AND ISNULL(a.Notes, N'') NOT LIKE N'E2E%'
    ORDER BY a.OrderAssignmentID DESC);
IF @TemplateId IS NULL
    THROW 50002, 'The template driver has no truck assignment to copy.', 1;

DECLARE @Seeds TABLE (Seq int IDENTITY PRIMARY KEY, Slot nvarchar(20), MessageType int, CodeHash char(64), AssignmentUuid uniqueidentifier, MessageUuid uniqueidentifier, State nvarchar(20));
INSERT @Seeds (Slot, MessageType, CodeHash, AssignmentUuid, MessageUuid, State)
SELECT
    JSON_VALUE(j, '$[0]'), CAST(JSON_VALUE(j, '$[1]') AS int), JSON_VALUE(j, '$[2]'),
    CAST(JSON_VALUE(j, '$[3]') AS uniqueidentifier), CAST(JSON_VALUE(j, '$[4]') AS uniqueidentifier), JSON_VALUE(j, '$[5]')
FROM (SELECT N'["' + REPLACE(LTRIM(RTRIM(value)), N',', N'","') + N'"]' AS j FROM STRING_SPLIT(@Rows, N';') WHERE LTRIM(RTRIM(value)) <> N'') r;

IF EXISTS (SELECT 1 FROM @Seeds WHERE MessageType NOT IN (10, 20) OR State NOT IN (N'open', N'expired', N'withdrawn', N'app') OR CodeHash NOT LIKE REPLICATE('[0-9a-f]', 64))
    THROW 50003, 'Each row is slot,type(10|20),codeHash,assignmentUuid,messageUuid,state(open|expired|withdrawn|app).', 1;

BEGIN TRANSACTION;

IF @DriverEmail <> N'-'
BEGIN
    DELETE auth.UserToRoles WHERE UserId = @DriverId;
    DELETE auth.Users WHERE Id = @DriverId;
    INSERT auth.Users
    (
        Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, SecurityStamp, ConcurrencyStamp,
        PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
        CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
    )
    SELECT
        @DriverId, CONVERT(uniqueidentifier, @DriverId), @DriverEmail, UPPER(@DriverEmail), @DriverEmail, UPPER(@DriverEmail), 1,
        UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
        @DriverPhone, 0, 0, 1, 0, N'E2E', N'QC-947 Driver',
        SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), t.OrganisationIdFk, t.OrganisationLocationIdFk, 0, 1, 0, 0
    FROM auth.Users t WHERE t.Id = @TemplateDriverId;
    INSERT auth.UserToRoles (UserId, RoleName) VALUES (@DriverId, N'Driver');
END

IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Id = @DriverId)
    THROW 50004, 'The driver is not a host user.', 1;

DECLARE @Cols nvarchar(max) = (
    SELECT STRING_AGG(QUOTENAME(name), N',') FROM sys.columns
    WHERE object_id = OBJECT_ID(N'app.OrderAssignments') AND is_identity = 0 AND is_computed = 0 AND system_type_id <> 189
      AND name NOT IN (N'OrderAssignmentUUID', N'AssignmentDate', N'OrderAssignmentStatusID_FK', N'Notes', N'Created', N'Updated', N'DriverUserID_FK'));

DECLARE @Seq int = 1, @Count int = (SELECT COUNT(*) FROM @Seeds);
DECLARE @Phone nvarchar(20) = (SELECT LEFT(PhoneNumber, 20) FROM auth.Users WHERE Id = @DriverId);
WHILE @Seq <= @Count
BEGIN
    DECLARE @Slot nvarchar(20), @Type int, @Hash char(64), @AUuid uniqueidentifier, @MUuid uniqueidentifier, @State nvarchar(20);
    SELECT @Slot = Slot, @Type = MessageType, @Hash = CodeHash, @AUuid = AssignmentUuid, @MUuid = MessageUuid, @State = State FROM @Seeds WHERE Seq = @Seq;
    DECLARE @Status int = CASE WHEN @State = N'withdrawn' THEN 8 WHEN @Type = 20 THEN 2 ELSE 1 END;
    DECLARE @Notes nvarchar(100) = @Marker + N' ' + @Slot;

    DECLARE @Sql nvarchar(max) = N'INSERT app.OrderAssignments (' + @Cols + N', DriverUserID_FK, OrderAssignmentUUID, AssignmentDate, OrderAssignmentStatusID_FK, Notes, Created, Updated)
        SELECT ' + @Cols + N', @DriverId, @AUuid, @Today, @Status, @Notes, @Now, @Now FROM app.OrderAssignments WHERE OrderAssignmentID = @TemplateId;';
    EXEC sp_executesql @Sql, N'@DriverId nvarchar(450), @AUuid uniqueidentifier, @Today date, @Status int, @Notes nvarchar(100), @Now datetime, @TemplateId int',
        @DriverId, @AUuid, @Today, @Status, @Notes, @Now, @TemplateId;
    DECLARE @AId int = (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE OrderAssignmentUUID = @AUuid);

    INSERT app.Messages
        (MessageUUID, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, Direction, MessageType, Channel, MessageBody, PhoneNumber, SentAt, IsActioned, Active, Created, Updated)
    SELECT @MUuid, @AId, @DriverId, a.VendorID_FK, 20, @Type, 10, @Notes + N' message', @Phone, @Now, 0, 1, @Now, @Now
    FROM app.OrderAssignments a WHERE a.OrderAssignmentID = @AId;
    DECLARE @MId int = (SELECT MessageID FROM app.Messages WHERE MessageUUID = @MUuid);

    INSERT app.MessageReplyLinks (MessageID_FK, CodeHash, ExpiresAt, AnsweredOption, AnsweredAt, AnsweredChannel, Created, Updated, Active)
    VALUES (
        @MId, @Hash,
        CASE WHEN @State = N'expired' THEN DATEADD(MINUTE, -60, @Now) ELSE DATEADD(DAY, 1, @Now) END,
        CASE WHEN @State = N'app' THEN N'accept' END,
        CASE WHEN @State = N'app' THEN DATEADD(MINUTE, -5, @Now) END,
        CASE WHEN @State = N'app' THEN 20 END,
        @Now, @Now, 1);

    PRINT CONCAT(N'SEED ', @Slot, N' assignment=', @AId, N';message=', @MId);
    SET @Seq += 1;
END

COMMIT TRANSACTION;
