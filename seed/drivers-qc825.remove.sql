-- QC-825: removes what drivers-qc825.apply.sql and the mirror cases left in DRIVERS_SQL_DATABASE for the drivers in
-- $(UserIds) (a comma-separated list of Identity subs; pass none when there are none): their mirror assignments, trips and
-- messages, their commands and their links, then every 'E2E QC-825%' host row with whatever is still attached to it.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT DISTINCT LTRIM(RTRIM(value)) FROM STRING_SPLIT(N'$(UserIds)', N',') WHERE LTRIM(RTRIM(value)) NOT IN (N'', N'none');

DECLARE @Hosts TABLE (Id int PRIMARY KEY);
INSERT @Hosts SELECT HostID FROM app.Hosts WHERE Name LIKE N'E2E QC-825%' AND CreatedBy = N'e2e';

BEGIN TRANSACTION;

DELETE app.MirrorMessages WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.MirrorTrips WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.MirrorAssignments WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.DriverCommands WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.DriverHostLinks WHERE UserID_FK IN (SELECT Id FROM @Users) OR HostID_FK IN (SELECT Id FROM @Hosts);
DELETE app.Hosts WHERE HostID IN (SELECT Id FROM @Hosts);

COMMIT TRANSACTION;
