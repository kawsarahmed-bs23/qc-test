-- QC-948: the DRIVERS side of reply-page-qc947.apply.sql (DRIVERS_SQL_DATABASE), so MessageAnswered from the host lands.
-- $(Rows) is the same list the host seed took ('slot,type,codeHash,assignmentUuid,messageUuid,state;...'). For each row it
-- copies the newest DRIVERS assignment of $(TemplateDriverUuid) at $(HostUuid) (made by no e2e seed) as assignmentUuid for
-- $(DriverUuid), dated today in app time, Notes 'E2E-QC947-RP <slot>', and adds the dispatch message messageUuid
-- (IsFromDispatch = 1, MessageType 20 for a status check, else 30). When $(Link) is 1 it also links $(DriverUuid) to the host
-- (app.DriverHostLinks, CreatedBy 'e2e-qc947'). drivers-reply-page-qc947.remove.sql deletes it all.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DriverUuid uniqueidentifier = N'$(DriverUuid)';
DECLARE @TemplateDriverUuid uniqueidentifier = N'$(TemplateDriverUuid)';
DECLARE @HostUuid uniqueidentifier = N'$(HostUuid)';
DECLARE @Link bit = $(Link);
DECLARE @Rows nvarchar(max) = N'$(Rows)';
DECLARE @Now datetime = GETUTCDATE();
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date);

IF NOT EXISTS (SELECT 1 FROM app.Hosts WHERE HostUUID = @HostUuid AND Active = 1)
    THROW 50001, 'The host is not an active host in the drivers database.', 1;

DECLARE @Template uniqueidentifier = (
    SELECT TOP 1 OrderAssignmentUUID FROM app.OrderAssignments
    WHERE DriverUserUUID = @TemplateDriverUuid AND HostUUID = @HostUuid AND ISNULL(Notes, N'') NOT LIKE N'E2E%'
    ORDER BY Created DESC);
IF @Template IS NULL
    THROW 50002, 'The template driver has no DRIVERS assignment at this host to copy.', 1;

DECLARE @Seeds TABLE (Seq int IDENTITY PRIMARY KEY, Slot nvarchar(20), MessageType int, AssignmentUuid uniqueidentifier, MessageUuid uniqueidentifier);
INSERT @Seeds (Slot, MessageType, AssignmentUuid, MessageUuid)
SELECT JSON_VALUE(j, '$[0]'), CAST(JSON_VALUE(j, '$[1]') AS int), CAST(JSON_VALUE(j, '$[3]') AS uniqueidentifier), CAST(JSON_VALUE(j, '$[4]') AS uniqueidentifier)
FROM (SELECT N'["' + REPLACE(LTRIM(RTRIM(value)), N',', N'","') + N'"]' AS j FROM STRING_SPLIT(@Rows, N';') WHERE LTRIM(RTRIM(value)) <> N'') r;

DECLARE @Cols nvarchar(max) = (
    SELECT STRING_AGG(QUOTENAME(name), N',') FROM sys.columns
    WHERE object_id = OBJECT_ID(N'app.OrderAssignments') AND is_identity = 0 AND is_computed = 0 AND system_type_id <> 189
      AND name NOT IN (N'OrderAssignmentUUID', N'AssignmentDate', N'Status', N'Notes', N'Created', N'Updated', N'CreatedBy', N'UpdatedBy', N'DriverUserUUID', N'Version'));

BEGIN TRANSACTION;

IF @Link = 1
BEGIN
    DELETE app.DriverHostLinks WHERE UserUUID = @DriverUuid AND HostUUID = @HostUuid;
    INSERT app.DriverHostLinks (UserUUID, HostUUID, DriverName, CreatedBy, UpdatedBy) VALUES (@DriverUuid, @HostUuid, N'E2E QC-947 Driver', N'e2e-qc947', N'e2e-qc947');
END

DECLARE @Seq int = 1, @Count int = (SELECT COUNT(*) FROM @Seeds);
WHILE @Seq <= @Count
BEGIN
    DECLARE @Slot nvarchar(20), @Type int, @AUuid uniqueidentifier, @MUuid uniqueidentifier;
    SELECT @Slot = Slot, @Type = MessageType, @AUuid = AssignmentUuid, @MUuid = MessageUuid FROM @Seeds WHERE Seq = @Seq;
    DECLARE @Notes nvarchar(100) = N'E2E-QC947-RP ' + @Slot;

    DECLARE @Sql nvarchar(max) = N'INSERT app.OrderAssignments (' + @Cols + N', OrderAssignmentUUID, DriverUserUUID, Version, AssignmentDate, Status, Notes, Created, Updated, CreatedBy, UpdatedBy)
        SELECT ' + @Cols + N', @AUuid, @DriverUuid, 1, @Today, CASE WHEN @Type = 20 THEN 2 ELSE 1 END, @Notes, @Now, @Now, N''e2e-qc947'', N''e2e-qc947''
        FROM app.OrderAssignments WHERE OrderAssignmentUUID = @Template;';
    EXEC sp_executesql @Sql, N'@AUuid uniqueidentifier, @DriverUuid uniqueidentifier, @Today date, @Type int, @Notes nvarchar(100), @Now datetime, @Template uniqueidentifier',
        @AUuid, @DriverUuid, @Today, @Type, @Notes, @Now, @Template;

    INSERT app.Messages
        (HostUUID, DriverUserUUID, MessageUUID, OrderAssignmentUUID, Version, IsFromDispatch, MessageType, MessageBody, SentAt, Created, Updated, Active, CreatedBy, UpdatedBy)
    VALUES (@HostUuid, @DriverUuid, @MUuid, @AUuid, 1, 1, CASE WHEN @Type = 20 THEN 20 ELSE 30 END, @Notes + N' message', @Now, @Now, @Now, 1, N'e2e-qc947', N'e2e-qc947');

    SET @Seq += 1;
END

COMMIT TRANSACTION;

PRINT CONCAT(N'SEED drivers rows=', @Count);
