-- QC-902 part 2: in DRIVERS_SQL_DATABASE (one-list schema 027-030 plus the deletion migrations 032-033), seeds three fake Drivers for the purge case (DEL-08).
-- They exist only in DRIVERS (no Identity user), each with an auth.Organisations row (E2E QC-902 Purge ...), an auth.Users row
-- (email e2e.qc902.purge.*@quarryconnect.test), the Driver role and an app.DriverSettings row:
--   $(DueUserId)       deletion due: requested 31 days ago, scheduled 5 minutes ago, not canceled. It also gets one row in
--                      app.OrderAssignments, Trips, Tickets, Messages, DeviceTokens, DriverHostLinks, DriverInvites (InvitedUserID),
--                      DriverCommands and SyncTombstones, keyed by UserUUID / DriverUserUUID and HostUUID (InvitedUserID by the lower-case UUID string). The purge must remove all of it.
--   $(FutureUserId)    deletion pending but scheduled in 29 days. The purge must leave it alone.
--   $(RestoredUserId)  scheduled 5 minutes ago but restored (DeletionCanceledAt set). The purge must leave it alone.
-- The host is $(HostUuid). drivers-qc902-deletion.remove.sql deletes everything here, including the DriverDeletions hash rows.
SET NOCOUNT ON;
SET XACT_ABORT ON;

IF OBJECT_ID(N'app.DriverDeletions', N'U') IS NULL OR COL_LENGTH(N'app.DriverSettings', N'DeletionRequestedAt') IS NULL
    THROW 50001, 'This DRIVERS database does not have the QC-902 deletion migrations (032-033).', 1;
IF COL_LENGTH(N'app.DriverHostLinks', N'UserUUID') IS NULL
    THROW 50004, 'This DRIVERS database does not have the QC-902 one-list migrations (027-030).', 1;

DECLARE @HostUuid uniqueidentifier = (SELECT HostUUID FROM app.Hosts WHERE HostUUID = CONVERT(uniqueidentifier, N'$(HostUuid)') AND Active = 1);
DECLARE @RoleTypeId varchar(100) = UPPER(CONVERT(varchar(36), (SELECT RoleTypeId FROM auth.RoleTypes WHERE RoleType = N'Driver')));
DECLARE @RoleId nvarchar(450) = (SELECT Id FROM auth.Roles WHERE NormalizedName = N'DRIVER');
IF @HostUuid IS NULL OR @RoleTypeId IS NULL OR @RoleId IS NULL
    THROW 50002, 'The local host, the Driver role type or the Driver role is missing.', 1;

DECLARE @Now datetime = CONVERT(datetime, CONVERT(datetime2(0), GETUTCDATE()));
DECLARE @Drivers TABLE (Kind varchar(10) PRIMARY KEY, UserUuid uniqueidentifier NOT NULL, RequestedAt datetime NOT NULL, ScheduledFor datetime NOT NULL, CanceledAt datetime NULL);
INSERT @Drivers VALUES
    ('due', N'$(DueUserId)', DATEADD(DAY, -31, @Now), DATEADD(MINUTE, -5, @Now), NULL),
    ('future', N'$(FutureUserId)', DATEADD(DAY, -1, @Now), DATEADD(DAY, 29, @Now), NULL),
    ('restored', N'$(RestoredUserId)', DATEADD(DAY, -31, @Now), DATEADD(MINUTE, -5, @Now), DATEADD(DAY, -2, @Now));

IF EXISTS (SELECT 1 FROM auth.Users u JOIN @Drivers d ON d.UserUuid = u.UserUUID)
    THROW 50003, 'A fake purge driver already exists; run drivers-qc902-deletion.remove.sql first.', 1;

BEGIN TRANSACTION;

DECLARE @Kind varchar(10), @UserUuid uniqueidentifier, @RequestedAt datetime, @ScheduledFor datetime, @CanceledAt datetime;
DECLARE drivers CURSOR LOCAL FAST_FORWARD FOR SELECT Kind, UserUuid, RequestedAt, ScheduledFor, CanceledAt FROM @Drivers;
OPEN drivers;
FETCH NEXT FROM drivers INTO @Kind, @UserUuid, @RequestedAt, @ScheduledFor, @CanceledAt;
WHILE @@FETCH_STATUS = 0
BEGIN
    DECLARE @Email nvarchar(256) = CONCAT(N'e2e.qc902.purge.', @Kind, N'@quarryconnect.test');
    DECLARE @UserKey nvarchar(450) = LOWER(CONVERT(nvarchar(36), @UserUuid));

    INSERT auth.Organisations (OrganisationName, OrganisationShortName, CountryClassIdFk, RoleTypeIdFk, UpdatedOn, UpdatedBy, IsActive)
    VALUES (CONCAT(N'E2E QC-902 Purge ', @Kind), 'EQP', 0, @RoleTypeId, GETUTCDATE(), 'e2e', 1);
    DECLARE @OrganisationId int = SCOPE_IDENTITY();

    DECLARE @Id nvarchar(450) = LOWER(CONVERT(nvarchar(36), NEWID()));
    INSERT auth.Users (Id, UserUUID, UserName, NormalizedUserName, Email, NormalizedEmail, FirstName, LastName, OrganisationIdFk, CreateDate, IsActive)
    VALUES (@Id, @UserUuid, @Email, UPPER(@Email), @Email, UPPER(@Email), N'E2E', CONCAT(N'QC-902 Purge ', @Kind), @OrganisationId, SYSDATETIMEOFFSET(), 1);

    INSERT auth.UserToRoles (UserId, RoleId) VALUES (@Id, @RoleId);

    INSERT app.DriverSettings (OrganisationID_FK, TruckNumber, CreatedBy, UpdatedBy, DeletionRequestedAt, DeletionScheduledFor, DeletionCanceledAt)
    VALUES (@OrganisationId, N'P-902', N'e2e-qc902', N'e2e-qc902', @RequestedAt, @ScheduledFor, @CanceledAt);

    INSERT app.DriverHostLinks (UserUUID, HostUUID, CreatedBy, UpdatedBy, SyncRequestedAt, SyncedAt, DriverName)
    VALUES (@UserUuid, @HostUuid, N'e2e-qc902', N'e2e-qc902', GETUTCDATE(), GETUTCDATE(), CONCAT(N'E2E QC-902 Purge ', @Kind));

    IF @Kind = 'due'
    BEGIN
        DECLARE @AssignmentUuid uniqueidentifier = NEWID();
        DECLARE @TripUuid uniqueidentifier = NEWID();

        INSERT app.OrderAssignments (HostUUID, DriverUserUUID, OrderAssignmentUUID, Version, AssignmentDate, Status, FulfillmentType, Notes, CreatedBy, UpdatedBy)
        VALUES (@HostUuid, @UserUuid, @AssignmentUuid, 1, CAST(GETUTCDATE() AS date), 2, 10, N'e2e-qc902-purge', N'e2e-qc902', N'e2e-qc902');

        INSERT app.Trips (HostUUID, UserUUID, OrderAssignmentUUID, TripUUID, Version, TripSequence, Status, CreatedBy, UpdatedBy)
        VALUES (@HostUuid, @UserUuid, @AssignmentUuid, @TripUuid, 1, 1, 1, N'e2e-qc902', N'e2e-qc902');

        INSERT app.Tickets (HostUUID, UserUUID, TicketUUID, TripUUID, OrderAssignmentUUID, Version, CreatedBy, UpdatedBy)
        VALUES (@HostUuid, @UserUuid, NEWID(), @TripUuid, @AssignmentUuid, 1, N'e2e-qc902', N'e2e-qc902');

        INSERT app.Messages (HostUUID, DriverUserUUID, MessageUUID, OrderAssignmentUUID, Version, IsFromDispatch, MessageType, SentAt, MessageBody, CreatedBy, UpdatedBy)
        VALUES (@HostUuid, @UserUuid, NEWID(), @AssignmentUuid, 1, 1, 1, GETUTCDATE(), N'e2e-qc902-purge message', N'e2e-qc902', N'e2e-qc902');

        INSERT app.DeviceTokens (DeviceTokenUUID, UserUUID, Token, Platform, DeviceId, LastSeenAt, CreatedBy, UpdatedBy)
        VALUES (NEWID(), @UserUuid, CONCAT(N'ExponentPushToken[e2e-qc902-purge-', @UserKey, N']'), N'ios', N'e2e-qc902-purge-device', GETUTCDATE(), N'e2e-qc902', N'e2e-qc902');

        INSERT app.DriverInvites (DriverInviteUUID, HostUUID, InvitedUserID, ExpiresAt, Status, CreatedBy, UpdatedBy)
        VALUES (NEWID(), @HostUuid, @UserKey, DATEADD(DAY, 7, GETUTCDATE()), 10, N'e2e-qc902', N'e2e-qc902');

        INSERT app.DriverCommands (CommandUUID, HostUUID, UserUUID, CommandType, Status, CreatedBy, UpdatedBy)
        VALUES (NEWID(), @HostUuid, @UserUuid, N'e2e-qc902-purge', 20, N'e2e-qc902', N'e2e-qc902');

        INSERT app.SyncTombstones (HostUUID, UserUUID, EntityType, EntityUUID, CreatedBy, UpdatedBy)
        VALUES (@HostUuid, @UserUuid, N'assignment', NEWID(), N'e2e-qc902', N'e2e-qc902');
    END

    FETCH NEXT FROM drivers INTO @Kind, @UserUuid, @RequestedAt, @ScheduledFor, @CanceledAt;
END
CLOSE drivers;
DEALLOCATE drivers;

COMMIT TRANSACTION;
