-- QC-1008: host-database rows for tests/app/user-signin-emails.spec.ts, for the e2e.qc913.*@example.com host user $(Email):
--   * links it to the Identity login $(UserUuid) (auth.Users.UserUUID), the way an accepted invite does, unless $(UserUuid) is none;
--   * adds an app.UserInvites row (Sent) created $(InviteHoursAgo) hours ago by the host user $(SentBy), unless $(InviteHoursAgo) is 0.
-- host-qc1008.remove.sql unlinks the users and deletes the invite rows; host-qc913.remove.sql removes the users with everything else.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @UserUuid nvarchar(40) = N'$(UserUuid)';
DECLARE @InviteHoursAgo int = $(InviteHoursAgo);
DECLARE @SentBy nvarchar(450) = N'$(SentBy)';

IF @Email NOT LIKE N'e2e.qc913.%@example.com'
    THROW 50001, 'The host user email must start with e2e.qc913. and end with @example.com.', 1;

DECLARE @UserId nvarchar(450) = (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
IF @UserId IS NULL
    THROW 50002, 'The host user does not exist.', 1;

BEGIN TRANSACTION;

IF @UserUuid <> N'none'
    UPDATE auth.Users SET UserUUID = CONVERT(uniqueidentifier, @UserUuid), EmailConfirmed = 1 WHERE Id = @UserId;

IF @InviteHoursAgo > 0
BEGIN
    DECLARE @Sent datetime = DATEADD(hour, -@InviteHoursAgo, GETUTCDATE());
    SET @Sent = DATEADD(second, -DATEPART(second, @Sent), DATEADD(millisecond, -DATEPART(millisecond, @Sent), @Sent));
    INSERT app.UserInvites (UserInviteUUID, UserID_FK, InvitedEmail, UserType, Status, ExpiresAt, SentByUserID_FK, Created, Updated, Active, CreatedBy, UpdatedBy)
    VALUES (NEWID(), @UserId, @Email, N'host', 10, DATEADD(hour, 24, @Sent), @SentBy, @Sent, @Sent, 1, N'e2e-qc1008', N'e2e-qc1008');
END;

COMMIT TRANSACTION;
