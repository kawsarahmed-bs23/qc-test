-- QC-937: host-database rows (LOCAL_SQL_DATABASE) for the reply confirmation cases (tests/app/reply-confirmation.spec.ts), nothing is sent.
--   * two Driver users in the organisation of $(TemplateDriverId): e2e.qc937.plain@quarryconnect.test (Id $(PlainId), phone 5125559371,
--     no UserUUID: the host texts it itself) and e2e.qc937.linked@quarryconnect.test (Id and UserUUID $(LinkedId), phone 5125559372:
--     a Driver App driver while Drivers:Mode is On);
--   * for each entry of $(Rows) ('slot,codeHash,assignmentUuid,messageUuid,who', separated by ';', who plain or linked): a Pending
--     assignment today in app time copied from the newest assignment of $(TemplateDriverId) not made by an e2e seed, Notes
--     'E2E-QC937-RC <slot>', an outbound job-offer SMS with body 'E2E-QC937-RC <slot> message' and its MessageReplyLinks row
--     (the code itself is never stored: codeHash is its lowercase SHA-256).
-- Prints 'SEED <slot> assignment=<id>;message=<id>' per slot. reply-confirmation-qc937.remove.sql deletes everything.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @PlainId nvarchar(450) = LOWER(N'$(PlainId)');
DECLARE @LinkedId nvarchar(450) = LOWER(N'$(LinkedId)');
DECLARE @TemplateDriverId nvarchar(450) = N'$(TemplateDriverId)';
DECLARE @Rows nvarchar(max) = N'$(Rows)';
DECLARE @Marker nvarchar(50) = N'E2E-QC937-RC';
DECLARE @Now datetime = GETUTCDATE();
DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

IF TRY_CONVERT(uniqueidentifier, @PlainId) IS NULL OR TRY_CONVERT(uniqueidentifier, @LinkedId) IS NULL
    THROW 50001, 'PlainId and LinkedId must be GUIDs.', 1;
IF EXISTS (SELECT 1 FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC937.%@QUARRYCONNECT.TEST') OR EXISTS (SELECT 1 FROM app.OrderAssignments WHERE Notes LIKE @Marker + N' %')
    THROW 50002, 'QC-937 rows are already there; run reply-confirmation-qc937.remove.sql first.', 1;

DECLARE @TemplateId int = (
    SELECT TOP 1 a.OrderAssignmentID FROM app.OrderAssignments a
    WHERE a.DriverUserID_FK = @TemplateDriverId AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL AND ISNULL(a.Notes, N'') NOT LIKE N'E2E%'
    ORDER BY a.OrderAssignmentID DESC);
IF @TemplateId IS NULL
    THROW 50003, 'The template driver has no truck assignment to copy.', 1;

DECLARE @Seeds TABLE (Seq int IDENTITY PRIMARY KEY, Slot nvarchar(20), CodeHash char(64), AssignmentUuid uniqueidentifier, MessageUuid uniqueidentifier, Who nvarchar(10));
INSERT @Seeds (Slot, CodeHash, AssignmentUuid, MessageUuid, Who)
SELECT JSON_VALUE(j, '$[0]'), JSON_VALUE(j, '$[1]'), CAST(JSON_VALUE(j, '$[2]') AS uniqueidentifier), CAST(JSON_VALUE(j, '$[3]') AS uniqueidentifier), JSON_VALUE(j, '$[4]')
FROM (SELECT N'["' + REPLACE(LTRIM(RTRIM(value)), N',', N'","') + N'"]' AS j FROM STRING_SPLIT(@Rows, N';') WHERE LTRIM(RTRIM(value)) <> N'') r;

IF EXISTS (SELECT 1 FROM @Seeds WHERE Who NOT IN (N'plain', N'linked') OR CodeHash NOT LIKE REPLICATE('[0-9a-f]', 64))
    THROW 50004, 'Each row is slot,codeHash,assignmentUuid,messageUuid,who(plain|linked).', 1;

BEGIN TRANSACTION;

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT
    p.Id, p.Uuid, p.Email, UPPER(p.Email), p.Email, UPPER(p.Email), 1,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    p.Phone, 0, 0, 1, 0, N'E2E', p.LastName,
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), t.OrganisationIdFk, t.OrganisationLocationIdFk, 0, 1, 0, 0
FROM (VALUES
    (@PlainId, CAST(NULL AS uniqueidentifier), N'e2e.qc937.plain@quarryconnect.test', N'5125559371', N'QC-937 Plain driver'),
    (@LinkedId, CONVERT(uniqueidentifier, @LinkedId), N'e2e.qc937.linked@quarryconnect.test', N'5125559372', N'QC-937 Linked driver')
) p (Id, Uuid, Email, Phone, LastName)
CROSS JOIN auth.Users t WHERE t.Id = @TemplateDriverId;
INSERT auth.UserToRoles (UserId, RoleName) VALUES (@PlainId, N'Driver'), (@LinkedId, N'Driver');

DECLARE @Cols nvarchar(max) = (
    SELECT STRING_AGG(QUOTENAME(name), N',') FROM sys.columns
    WHERE object_id = OBJECT_ID(N'app.OrderAssignments') AND is_identity = 0 AND is_computed = 0 AND system_type_id <> 189
      AND name NOT IN (N'OrderAssignmentUUID', N'AssignmentDate', N'OrderAssignmentStatusID_FK', N'Notes', N'Created', N'Updated', N'DriverUserID_FK'));

DECLARE @Seq int = 1, @Count int = (SELECT COUNT(*) FROM @Seeds);
WHILE @Seq <= @Count
BEGIN
    DECLARE @Slot nvarchar(20), @Hash char(64), @AUuid uniqueidentifier, @MUuid uniqueidentifier, @Who nvarchar(10);
    SELECT @Slot = Slot, @Hash = CodeHash, @AUuid = AssignmentUuid, @MUuid = MessageUuid, @Who = Who FROM @Seeds WHERE Seq = @Seq;
    DECLARE @DriverId nvarchar(450) = CASE WHEN @Who = N'plain' THEN @PlainId ELSE @LinkedId END;
    DECLARE @Phone nvarchar(20) = (SELECT LEFT(PhoneNumber, 20) FROM auth.Users WHERE Id = @DriverId);
    DECLARE @Notes nvarchar(100) = @Marker + N' ' + @Slot;

    DECLARE @Sql nvarchar(max) = N'INSERT app.OrderAssignments (' + @Cols + N', DriverUserID_FK, OrderAssignmentUUID, AssignmentDate, OrderAssignmentStatusID_FK, Notes, Created, Updated)
        SELECT ' + @Cols + N', @DriverId, @AUuid, @Today, 1, @Notes, @Now, @Now FROM app.OrderAssignments WHERE OrderAssignmentID = @TemplateId;';
    EXEC sp_executesql @Sql, N'@DriverId nvarchar(450), @AUuid uniqueidentifier, @Today date, @Notes nvarchar(100), @Now datetime, @TemplateId int',
        @DriverId, @AUuid, @Today, @Notes, @Now, @TemplateId;
    DECLARE @AId int = (SELECT OrderAssignmentID FROM app.OrderAssignments WHERE OrderAssignmentUUID = @AUuid);

    INSERT app.Messages
        (MessageUUID, OrderAssignmentID_FK, DriverUserID_FK, VendorID_FK, Direction, MessageType, Channel, MessageBody, PhoneNumber, SentAt, IsActioned, Active, Created, Updated)
    SELECT @MUuid, @AId, @DriverId, a.VendorID_FK, 20, 10, 10, @Notes + N' message', @Phone, @Now, 0, 1, @Now, @Now
    FROM app.OrderAssignments a WHERE a.OrderAssignmentID = @AId;
    DECLARE @MId int = (SELECT MessageID FROM app.Messages WHERE MessageUUID = @MUuid);

    INSERT app.MessageReplyLinks (MessageID_FK, CodeHash, ExpiresAt, Created, Updated, Active)
    VALUES (@MId, @Hash, DATEADD(DAY, 1, @Now), @Now, @Now, 1);

    PRINT CONCAT(N'SEED ', @Slot, N' assignment=', @AId, N';message=', @MId);
    SET @Seq += 1;
END

COMMIT TRANSACTION;
