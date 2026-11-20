-- QC-1008: the sign-in email history of one throwaway Identity login (e2e.qc913.*@example.com), in the Identity database, for
-- tests/app/user-signin-emails.spec.ts. Four rows for the host client $(HostClient) (newest first: a refused Forgot Password two hours
-- ago, a sign-in link the mail server refused five hours ago, a password reset sent a day ago requested by the host user $(AdminId))
-- and four rows at other clients that the host log must not show (another host client, and no client). The rows at other clients
-- carry the requester e2e-qc1008. identity-qc1008.remove.sql deletes every row of the login.
-- Re-running replaces the rows. $(OtherClient) is another host client id in HOST_MASTER.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Email nvarchar(256) = N'$(Email)';
DECLARE @AdminId nvarchar(450) = N'$(AdminId)';
DECLARE @HostClient nvarchar(200) = N'$(HostClient)';
DECLARE @OtherClient nvarchar(200) = N'$(OtherClient)';

IF @Email NOT LIKE N'e2e.qc913.%@example.com'
    THROW 50001, 'The throwaway login email must start with e2e.qc913. and end with @example.com.', 1;

DECLARE @UserId nvarchar(450) = (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
IF @UserId IS NULL
    THROW 50002, 'The throwaway Identity login does not exist.', 1;

DECLARE @Now datetimeoffset = SYSDATETIMEOFFSET();
DECLARE @Minute datetimeoffset = DATEADD(second, -DATEPART(second, @Now), DATEADD(nanosecond, -DATEPART(nanosecond, @Now), @Now));

BEGIN TRANSACTION;

DELETE auth.PasswordResetLinks WHERE UserId = @UserId;
DELETE auth.MagicLinkTokens WHERE UserId = @UserId;
DELETE auth.AccountEmailRefusals WHERE UserId = @UserId;

INSERT auth.PasswordResetLinks (TokenHash, UserId, ClientId, ReturnUrl, SecurityStamp, Created, Expires, Consumed, SendStatus, SendFailure, RequestedByHostUserId)
VALUES
    (CONVERT(char(64), HASHBYTES('SHA2_256', CONVERT(varchar(40), NEWID())), 2), @UserId, @HostClient, NULL, NULL,
        DATEADD(day, -1, @Minute), DATEADD(hour, -22, @Minute), NULL, 1, NULL, @AdminId),
    (CONVERT(char(64), HASHBYTES('SHA2_256', CONVERT(varchar(40), NEWID())), 2), @UserId, @OtherClient, NULL, NULL,
        DATEADD(hour, -3, @Minute), DATEADD(hour, -1, @Minute), NULL, 2, 'email-off', 'e2e-qc1008'),
    (CONVERT(char(64), HASHBYTES('SHA2_256', CONVERT(varchar(40), NEWID())), 2), @UserId, NULL, NULL, NULL,
        DATEADD(hour, -4, @Minute), DATEADD(hour, -2, @Minute), NULL, 2, 'email-off', 'e2e-qc1008');

INSERT auth.MagicLinkTokens (TokenHash, UserId, ClientId, ReturnUrl, SecurityStamp, Created, Expires, Consumed, RequestIp, BindingNonceHash, SendStatus, SendFailure, RequestedByHostUserId)
VALUES
    (CONVERT(char(64), HASHBYTES('SHA2_256', CONVERT(varchar(40), NEWID())), 2), @UserId, @HostClient, NULL, NULL,
        DATEADD(hour, -5, @Minute), DATEADD(hour, -4, @Minute), NULL, NULL, NULL, 2, 'mail-server-refused', NULL),
    (CONVERT(char(64), HASHBYTES('SHA2_256', CONVERT(varchar(40), NEWID())), 2), @UserId, @OtherClient, NULL, NULL,
        DATEADD(hour, -6, @Minute), DATEADD(hour, -5, @Minute), NULL, NULL, NULL, 1, NULL, 'e2e-qc1008');

INSERT auth.AccountEmailRefusals (UserId, ClientId, Kind, Reason, RequestedByHostUserId, Created)
VALUES
    (@UserId, @HostClient, 'password-reset', 'login-deactivated', @AdminId, DATEADD(hour, -2, @Minute)),
    (@UserId, @OtherClient, 'sign-in-link', 'too-many-requests', 'e2e-qc1008', DATEADD(hour, -1, @Minute));

COMMIT TRANSACTION;
