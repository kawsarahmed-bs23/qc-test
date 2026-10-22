-- QC-665: a host-database driver row for e2e.qc665.driver1, so the Drivers API's /me can read the driver's profile from
-- the host API (GET /api/drivers-service/drivers/{userId}). Run against the host database (LOCAL_SQL_DATABASE).
-- $(UserId) is the Identity user id of e2e.qc665.driver1 (Identity sub = host auth.Users.Id). The driver gets
-- phone 5125550665 and is placed in $(TruckOrganisationId) (a Truck organisation whose parent is the vendor).
-- Safe to re-run. host-qc665.remove.sql deletes it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
DECLARE @Email nvarchar(256) = N'e2e.qc665.driver1@quarryconnect.test';
DECLARE @TruckOrganisationId int = $(TruckOrganisationId);

IF NOT EXISTS (SELECT 1 FROM auth.Organisations WHERE OrganisationId = @TruckOrganisationId)
    THROW 50001, 'The truck organisation does not exist in the host database.', 1;

BEGIN TRANSACTION;

DELETE auth.UserToRoles WHERE UserId IN (SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(@Email));
DELETE auth.Users WHERE NormalizedEmail = UPPER(@Email);

INSERT auth.Users
(
    Id, UserName, NormalizedUserName, Email, NormalizedEmail, EmailConfirmed, PhoneNumber, PhoneNumberConfirmed,
    TwoFactorEnabled, LockoutEnabled, AccessFailedCount, FirstName, LastName, CreateDate, LastLoginDate, LastPasswordChangedDate,
    RejectedEULA, PasswordResetFlag, Discriminator, OrganisationIdFk, OrganisationLocationIdFk, IsActive, Digest,
    SecurityStamp, ConcurrencyStamp
)
VALUES
(
    @UserId, @Email, UPPER(@Email), @Email, UPPER(@Email), 1, N'5125550665', 0,
    0, 1, 0, N'Hostfirst', N'Hostlast', SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(), SYSDATETIMEOFFSET(),
    0, 0, N'Users', @TruckOrganisationId,
    (SELECT TOP 1 OrganisationLocationIdFk FROM auth.Users WHERE OrganisationIdFk = @TruckOrganisationId AND OrganisationLocationIdFk IS NOT NULL), 1, 0,
    UPPER(REPLACE(CONVERT(nvarchar(36), NEWID()), N'-', N'')), CONVERT(nvarchar(36), NEWID())
);

INSERT auth.UserToRoles (UserId, RoleName) VALUES (@UserId, N'Driver');

COMMIT TRANSACTION;
