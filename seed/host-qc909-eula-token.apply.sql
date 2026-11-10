-- QC-909 e2e copy of quarryconnect-sql/migrations/pending/eula_host_name_token.sql (keep the two the same).
-- The host EULA cases (HEULA-*) apply it in beforeAll only when the live EULA has no {{HostName}} yet, and always
-- undo it with host-qc909-eula-token.remove.sql in afterAll. Run against the host database.
-- =============================================
-- Migration: The user EULA names the Host through the {{HostName}} token
-- Ticket: QC-909
-- Date: 2026-11-09
-- Description: The live auth.UserEULADocs text had "Rock Ridge Transport" typed into it, so every Host copied
--              from it showed that company's name. Every occurrence in the live row(s) becomes {{HostName}},
--              which the host API fills in with the Host organisation's name before showing or saving the EULA.
--              The row is updated in place (same UserEULADocId, same Version), so users who already accepted
--              are not asked again.
--              Dry run: set @DryRun = 1. The matches are printed and the change is rolled back.
--              Runs again safely: a second run finds no matches and changes nothing.
--              Deploy with (or after) the QC-909 API; the old API would show the raw token.
-- Rollback: migrations/rollbacks/pending/rollback_eula_host_name_token.sql
-- =============================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @DryRun BIT = 0;
DECLARE @TypedName NVARCHAR(100) = N'Rock Ridge Transport';
DECLARE @Token NVARCHAR(20) = N'{{HostName}}';

BEGIN TRANSACTION;

SELECT [UserEULADocId],
       [Version],
       (LEN([EULAText]) - LEN(REPLACE([EULAText], @TypedName, N''))) / LEN(@TypedName) AS [Matches]
FROM [auth].[UserEULADocs]
WHERE [IsLive] = 1
  AND [EULAText] LIKE N'%' + @TypedName + N'%';

UPDATE [auth].[UserEULADocs]
SET [EULAText] = REPLACE([EULAText], @TypedName, @Token)
WHERE [IsLive] = 1
  AND [EULAText] LIKE N'%' + @TypedName + N'%';

DECLARE @Updated INT = @@ROWCOUNT;

IF @DryRun = 1
BEGIN
    ROLLBACK TRANSACTION;
    PRINT CONCAT('Dry run: ', @Updated, ' live EULA row(s) would use {{HostName}}; nothing changed');
END
ELSE
BEGIN
    COMMIT TRANSACTION;
    IF @Updated > 0
        PRINT CONCAT(@Updated, ' live EULA row(s) now use {{HostName}}');
    ELSE
        PRINT 'No live EULA names Rock Ridge Transport; unchanged';
END
