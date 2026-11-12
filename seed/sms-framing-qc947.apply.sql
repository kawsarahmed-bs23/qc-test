-- QC-947: a second never-texted Driver for the SMS framing cases (tests/app/sms-framing.spec.ts, SMSFMT-01…08), for a host
-- database copy that has only one active Driver with a live assignment and no SMS ever sent to their phone. Run against
-- the host database (LOCAL_SQL_DATABASE) only.
--   * auth.Users e2e.qc947.framing@quarryconnect.test (no UserUUID, so nothing is mirrored to DRIVERS), the Driver role and
--     the phone $(Phone), in the organisation of $(TemplateDriverId);
--   * one Accepted assignment today in app time, Notes 'E2E-QC947-SMSFMT', copied from the newest truck assignment of
--     $(TemplateDriverId) not made by an e2e seed (order, job, vendor, truck and times).
-- No message is added, so the phone stays never texted. Re-running replaces the rows; sms-framing-qc947.remove.sql deletes them.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'e2e.qc947.framing@quarryconnect.test';
DECLARE @Phone nvarchar(20) = N'$(Phone)';
DECLARE @TemplateDriverId nvarchar(450) = N'$(TemplateDriverId)';
DECLARE @Marker nvarchar(50) = N'E2E-QC947-SMSFMT';
DECLARE @Now datetime = GETUTCDATE();
DECLARE @TimeZoneId nvarchar(100) = ISNULL(
    (SELECT TOP 1 PropertyValue FROM app.EnvironmentSetting WHERE GroupName = N'TimeZoneSettings' AND PropertyName = N'TimeZoneId'),
    N'Central Standard Time');
DECLARE @Today date = CAST(SYSDATETIMEOFFSET() AT TIME ZONE @TimeZoneId AS date);

IF EXISTS (SELECT 1 FROM app.Messages WHERE REPLACE(REPLACE(PhoneNumber, N'+1', N''), N'-', N'') = REPLACE(@Phone, N'+1', N'') AND Direction = 20)
    THROW 50001, 'That phone has already been texted; pick another.', 1;

DECLARE @TemplateId int = (
    SELECT TOP 1 a.OrderAssignmentID FROM app.OrderAssignments a JOIN app.Orders o ON o.OrderID = a.OrderID_FK
    WHERE a.DriverUserID_FK = @TemplateDriverId AND a.AssignmentType = 10 AND a.TruckID_FK IS NOT NULL AND o.Active = 1
      AND ISNULL(a.Notes, N'') NOT LIKE N'E2E%'
    ORDER BY a.OrderAssignmentID DESC);
IF @TemplateId IS NULL
    THROW 50002, 'The template driver has no truck assignment on an active order to copy.', 1;

BEGIN TRANSACTION;

DECLARE @Old nvarchar(450) = (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE app.OrderAssignments WHERE Notes = @Marker;
DELETE auth.UserToRoles WHERE UserId = @Old;
DELETE auth.Users WHERE Id = @Old;

DECLARE @DriverId nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, SecurityStamp, ConcurrencyStamp,
    PhoneNumber, PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
SELECT
    @DriverId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    @Phone, 0, 0, 1, 0, N'E2E', N'QC-947 Framing driver',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), t.OrganisationIdFk, t.OrganisationLocationIdFk, 0, 1, 0, 0
FROM auth.Users t WHERE t.Id = @TemplateDriverId;
INSERT auth.UserToRoles (UserId, RoleName) VALUES (@DriverId, N'Driver');

DECLARE @Cols nvarchar(max) = (
    SELECT STRING_AGG(QUOTENAME(name), N',') FROM sys.columns
    WHERE object_id = OBJECT_ID(N'app.OrderAssignments') AND is_identity = 0 AND is_computed = 0 AND system_type_id <> 189
      AND name NOT IN (N'OrderAssignmentUUID', N'AssignmentDate', N'OrderAssignmentStatusID_FK', N'Notes', N'Created', N'Updated', N'DriverUserID_FK', N'Active'));
DECLARE @Sql nvarchar(max) = N'INSERT app.OrderAssignments (' + @Cols + N', DriverUserID_FK, OrderAssignmentUUID, AssignmentDate, OrderAssignmentStatusID_FK, Notes, Created, Updated, Active)
    SELECT ' + @Cols + N', @DriverId, NEWID(), @Today, 2, @Marker, @Now, @Now, 1 FROM app.OrderAssignments WHERE OrderAssignmentID = @TemplateId;';
EXEC sp_executesql @Sql, N'@DriverId nvarchar(450), @Today date, @Marker nvarchar(50), @Now datetime, @TemplateId int', @DriverId, @Today, @Marker, @Now, @TemplateId;

COMMIT TRANSACTION;

PRINT CONCAT(N'SEED driver=', @DriverId);
