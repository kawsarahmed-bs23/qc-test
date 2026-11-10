-- QC-898: one host-database user e2e.qc898.*@quarryconnect.test for the host sign-in and invite-link cases
-- (tests/33-host-uuids.spec.ts), with no password (it only signs in through the identity exchange), the host role
-- $(RoleName), organisation $(OrganisationId) and the live EULA signed.
--   $(UserId)   the row's Id; 'new' makes a random one (a host row whose Id is not any Identity user's Id),
--   $(UserUuid) the row's UserUUID; 'none' leaves it NULL (a host row QC-898's back-fill or a sign-in has not stamped yet).
--   $(WithAssignment) 1 also adds a driver assignment for the user on the 'e2e-qc898' order (host-qc898.apply.sql), with
--   the user's truck and that truck's vendor, written straight to the table so VendorUUID, TruckUUID and DriverUserUUID
--   are NULL, as on rows the QC-898 back-fill found without a linked driver.
-- Re-running replaces the user; host-qc898.remove.sql deletes it with everything a sign-in or link left.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @UserId nvarchar(450) = CASE WHEN N'$(UserId)' = N'new' THEN LOWER(CONVERT(nvarchar(36), NEWID())) ELSE N'$(UserId)' END;
DECLARE @UserUuid uniqueidentifier = CASE WHEN N'$(UserUuid)' = N'none' THEN NULL ELSE CONVERT(uniqueidentifier, N'$(UserUuid)') END;
DECLARE @RoleName nvarchar(256) = N'$(RoleName)';
DECLARE @OrganisationId int = $(OrganisationId);
DECLARE @WithAssignment bit = $(WithAssignment);

IF @Email NOT LIKE N'e2e.qc898.%@quarryconnect.test'
    THROW 50001, 'The host user email must start with e2e.qc898. and end with @quarryconnect.test.', 1;
IF @RoleName NOT IN (N'Admin', N'Driver')
    THROW 50002, 'The host role must be Admin or Driver.', 1;
IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @OrganisationId)
    THROW 50003, 'The organisation does not exist in the host database.', 1;

DECLARE @OrderId int, @AssignmentDate date;
IF @WithAssignment = 1
BEGIN
    SELECT TOP 1 @OrderId = OrderID, @AssignmentDate = CAST(OrderStartDate AS date) FROM app.Orders WHERE Notes = N'e2e-qc898' AND Active = 1 ORDER BY OrderID DESC;
    IF @OrderId IS NULL
        THROW 50004, 'The e2e-qc898 order is missing; run host-qc898.apply.sql first.', 1;
END

DECLARE @EulaDocId int;
DECLARE @EulaVersion nvarchar(50);
SELECT TOP 1 @EulaDocId = UserEULADocId, @EulaVersion = Version FROM auth.UserEULADocs WHERE IsLive = 1 ORDER BY ActiveDate DESC;

BEGIN TRANSACTION;

DELETE auth.UserClaims WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserSignedEULAs WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users
(
    Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @UserUuid, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, 0,
    0, 1, 0, N'E2E', N'QC-898 ' + @RoleName, SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, @OrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @OrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, @RoleName);

IF @EulaDocId IS NOT NULL
    INSERT auth.UserSignedEULAs (UserId, UserEULADocId, EULAVersion, CreatedDate) VALUES (@UserId, @EulaDocId, @EulaVersion, SYSDATETIME());

IF @WithAssignment = 1
    INSERT app.OrderAssignments
    (
        Created, Updated, Active, OrderID_FK, VendorID_FK, DriverUserID_FK, TruckID_FK, AssignmentDate, TimeWindowStart, TimeWindowEnd,
        LoadsAssigned, NotificationSent, Notes, AssignmentType, FulfillmentType, OrderAssignmentStatusID_FK, OrderAssignmentUUID
    )
    SELECT GETUTCDATE(), GETUTCDATE(), 1, @OrderId, t.ParentOrganisationIdFk, @UserId, t.OrganisationID, @AssignmentDate, '00:00', '23:59',
           4, 0, N'e2e-qc898 seeded', 10, 10, 1, NEWID()
    FROM auth.Organisations t WHERE t.OrganisationID = @OrganisationId;

COMMIT TRANSACTION;
