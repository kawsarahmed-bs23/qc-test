-- QC-825: a second throwaway driver $(UserId) ($(Email)) in the host database, only an auth.Users row with the Driver role
-- (same Id as its Identity sub, password hash read from [$(IdentityDb)]), so DMIR-14 can reassign an assignment to it.
-- host-qc825.remove.sql deletes it with every other e2e.qc825.* user.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'$(Email)';

IF @Email NOT LIKE N'e2e.qc825.%@quarryconnect.test'
    THROW 50001, 'The throwaway driver email must start with e2e.qc825. and end with @quarryconnect.test.', 1;

DECLARE @PasswordHash nvarchar(max) = (SELECT PasswordHash FROM [$(IdentityDb)].dbo.Users WHERE Id = @UserId AND NormalizedEmail = UPPER(@Email));
IF @PasswordHash IS NULL
    THROW 50002, 'The throwaway Identity driver does not exist; run identity-qc825-user.apply.sql first.', 1;

DECLARE @OrganisationId int = (
    SELECT TOP 1 u.OrganisationIdFk FROM auth.Users u JOIN auth.UserToRoles r ON r.UserId = u.Id
    WHERE r.RoleName = N'Driver' AND u.OrganisationIdFk IS NOT NULL AND u.NormalizedEmail NOT LIKE N'E2E.QC825.%');

BEGIN TRANSACTION;

DELETE auth.UserToRoles WHERE UserId = @UserId;
DELETE auth.Users WHERE Id = @UserId;

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PasswordHash, SecurityStamp, ConcurrencyStamp,
    PhoneNumberConfirmed, TwoFactorEnabled, LockoutEnabled, AccessFailedCount, Discriminator, FirstName, LastName,
    CreateDate, LastLoginDate, LastPasswordChangedDate, OrganisationIdFk, OrganisationLocationIdFk, PasswordResetFlag, IsActive, RejectedEULA, Digest
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, @PasswordHash,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID()),
    0, 0, 1, 0, N'Users', N'E2E', N'QC-825 Second driver',
    SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), @OrganisationId, 0, 0, 1, 0, 0
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Driver');

COMMIT TRANSACTION;
