-- QC-909: removes the Driver App EULA acceptances (app.DriverSignedEulas) of one driver, $(UserId) (the token's sub),
-- which the DEULA-* cases make through POST /eula/accept. The cases only run when that driver had none before.
-- Run against the DRIVERS database (DRIVERS_SQL_DATABASE).
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @UserId nvarchar(450) = N'$(UserId)';
IF LEN(@UserId) < 10
    THROW 50001, 'UserId must be the driver''s Identity id.', 1;

DELETE app.DriverSignedEulas WHERE UserID_FK = @UserId;
