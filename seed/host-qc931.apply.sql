-- QC-931: availability questions for the AVAIL cases (tests/app/availability.spec.ts), in the host database (LOCAL_SQL_DATABASE).
-- $(DriverId) is the Driver the questions went to. $(Rows) is 'slot,messageType,codeHash,dayOffset,state;...':
--   messageType 60 today, 70 tomorrow, 80 next week; dayOffset the days from today in app time of the question's AvailabilityDate;
--   state open (no answer), yes, no or days (answered on the web, with an inbound answer message, Channel 30).
-- Each row adds an outbound dispatch message 'E2E-QC931 <slot> <question>' (Channel 10, CreatedBy e2e-qc931), its MessageReplyLinks
-- row (ExpiresAt two days after the date) and, for an answered state, the inbound answer message. Prints 'SEED <slot> message=<id>'.
-- When $(OrderDays) is more than 0 it also adds an open order Notes 'e2e-qc931' (job, truck type and dispatcher copied from the newest
-- real driver assignment) from today for that many days, and prints 'ORDER <id>'. host-qc931.remove.sql deletes all of it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DriverId nvarchar(450) = N'$(DriverId)';
DECLARE @Rows nvarchar(max) = N'$(Rows)';
DECLARE @OrderDays int = $(OrderDays);
DECLARE @Marker nvarchar(50) = N'e2e-qc931';
DECLARE @Now datetime = GETUTCDATE();
DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

IF NOT EXISTS (SELECT 1 FROM auth.Users WHERE Id = @DriverId)
    THROW 50001, 'The Driver is not in auth.Users.', 1;
IF EXISTS (SELECT 1 FROM app.Messages WHERE CreatedBy = @Marker) OR EXISTS (SELECT 1 FROM app.Orders WHERE Notes = @Marker)
    THROW 50002, 'QC-931 data is already there; run host-qc931.remove.sql first.', 1;

DECLARE @Phone nvarchar(20) = (SELECT PhoneNumber FROM auth.Users WHERE Id = @DriverId);
DECLARE @E164 nvarchar(20) = CASE WHEN LEFT(@Phone, 1) = N'+' THEN @Phone ELSE N'+1' + @Phone END;

DECLARE @Seeds TABLE (Seq int IDENTITY PRIMARY KEY, Slot nvarchar(30), MessageType int, CodeHash varchar(64), DayOffset int, State nvarchar(10));
INSERT @Seeds (Slot, MessageType, CodeHash, DayOffset, State)
SELECT JSON_VALUE(j, '$[0]'), CAST(JSON_VALUE(j, '$[1]') AS int), JSON_VALUE(j, '$[2]'), CAST(JSON_VALUE(j, '$[3]') AS int), JSON_VALUE(j, '$[4]')
FROM (SELECT N'["' + REPLACE(LTRIM(RTRIM(value)), N',', N'","') + N'"]' AS j FROM STRING_SPLIT(@Rows, N';') WHERE LTRIM(RTRIM(value)) <> N'') r;

BEGIN TRANSACTION;

DECLARE @Seq int = 1, @Count int = (SELECT COUNT(*) FROM @Seeds);
WHILE @Seq <= @Count
BEGIN
    DECLARE @Slot nvarchar(30), @Type int, @Hash varchar(64), @Offset int, @State nvarchar(10);
    SELECT @Slot = Slot, @Type = MessageType, @Hash = CodeHash, @Offset = DayOffset, @State = State FROM @Seeds WHERE Seq = @Seq;
    DECLARE @Date date = DATEADD(DAY, @Offset, @Today);
    DECLARE @Question nvarchar(100) = CASE @Type WHEN 60 THEN N'Are you available for work today?' WHEN 70 THEN N'Are you available for work tomorrow?' ELSE N'Are you available for work next week?' END;

    INSERT app.Messages (Created, Updated, Active, DriverUserID_FK, MessageBody, PhoneNumber, SentAt, IsActioned, Direction, MessageType, Channel, MessageUUID, CreatedBy, UpdatedBy, AvailabilityDate)
    VALUES (@Now, @Now, 1, @DriverId, N'E2E-QC931 ' + @Slot + N' ' + @Question, @E164, @Now, 0, 20, @Type, 10, NEWID(), @Marker, @Marker, @Date);
    DECLARE @MId int = SCOPE_IDENTITY();

    DECLARE @AnswerId int = NULL;
    IF @State IN (N'yes', N'no', N'days')
    BEGIN
        INSERT app.Messages (Created, Updated, Active, DriverUserID_FK, MessageBody, PhoneNumber, IsActioned, AiClassification, Direction, MessageType, ReplyToMessageID_FK, Channel, MessageUUID, CreatedBy, UpdatedBy)
        VALUES (@Now, @Now, 1, @DriverId, CASE @State WHEN N'yes' THEN N'Yes' WHEN N'no' THEN N'No' ELSE N'Only these days: Mon and Tue only' END, @E164, 1, 40, 10, 40, @MId, 30, NEWID(), @Marker, @Marker);
        SET @AnswerId = SCOPE_IDENTITY();
    END

    INSERT app.MessageReplyLinks (MessageID_FK, CodeHash, ExpiresAt, AnsweredOption, AnsweredAt, AnswerMessageID_FK, AnsweredChannel, Created, Updated, Active)
    VALUES (@MId, @Hash, DATEADD(DAY, 2, CAST(@Date AS datetime)),
        CASE @State WHEN N'yes' THEN N'yes' WHEN N'no' THEN N'no' WHEN N'days' THEN N'only-days' END,
        CASE WHEN @AnswerId IS NULL THEN NULL ELSE @Now END, @AnswerId, CASE WHEN @AnswerId IS NULL THEN NULL ELSE 30 END, @Now, @Now, 1);

    PRINT CONCAT(N'SEED ', @Slot, N' message=', @MId);
    SET @Seq += 1;
END

IF @OrderDays > 0
BEGIN
    DECLARE @JobId int, @TruckTypeId int, @DispatcherUserId nvarchar(450);
    SELECT TOP 1 @JobId = o.JobID_FK, @TruckTypeId = o.TruckTypeID_FK, @DispatcherUserId = o.DispatcherUserID_FK
    FROM app.OrderAssignments oa
    JOIN app.Orders o ON o.OrderID = oa.OrderID_FK
    WHERE oa.AssignmentType = 10 AND oa.TruckID_FK IS NOT NULL AND oa.Active = 1 AND o.Active = 1
      AND ISNULL(oa.Notes, N'') NOT LIKE N'e2e%' AND ISNULL(o.Notes, N'') NOT LIKE N'e2e%'
    ORDER BY oa.OrderAssignmentID DESC;
    IF @JobId IS NULL
        THROW 50003, 'No driver assignment to copy the job, truck type and dispatcher from.', 1;

    INSERT app.Orders (Created, Updated, Active, JobID_FK, DispatcherUserID_FK, AreaID_FK, TruckTypeID_FK, TrucksNeeded, OrderStartDate, OrderEndDate, TimeWindowStart, TimeWindowEnd, LoadsPerTruck, IsQuote, Notes, FulfillmentType, OrderStatusID_FK)
    VALUES (@Now, @Now, 1, @JobId, @DispatcherUserId, NULL, @TruckTypeId, 3, @Today, DATEADD(DAY, @OrderDays, @Today), '06:00', '18:00', 2, 0, @Marker, 10, 2);
    PRINT CONCAT(N'ORDER ', SCOPE_IDENTITY());
END

COMMIT TRANSACTION;
