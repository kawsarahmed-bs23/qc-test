-- QC-909 e2e copy of quarryconnect-sql/migrations/rollbacks/pending/rollback_eula_host_name_token.sql (keep the two the same).
-- Undoes host-qc909-eula-token.apply.sql after the host EULA cases. Run against the host database.
-- =============================================
-- Rollback: The user EULA names the Host through the {{HostName}} token
-- Ticket: QC-909
-- Date: 2026-11-09
-- Description: Puts "Rock Ridge Transport" back wherever the live auth.UserEULADocs text says {{HostName}},
--              which restores the text as it was before the migration. Deploy only with the pre-QC-909 API.
--              Runs again safely: a second run finds no token and changes nothing.
-- Migration: migrations/pending/eula_host_name_token.sql
-- =============================================

SET NOCOUNT ON;
SET XACT_ABORT ON;

BEGIN TRANSACTION;

UPDATE [auth].[UserEULADocs]
SET [EULAText] = REPLACE([EULAText], N'{{HostName}}', N'Rock Ridge Transport')
WHERE [IsLive] = 1
  AND [EULAText] LIKE N'%{{HostName}}%';

DECLARE @Updated INT = @@ROWCOUNT;

COMMIT TRANSACTION;

IF @Updated > 0
    PRINT CONCAT(@Updated, ' live EULA row(s) name Rock Ridge Transport again');
ELSE
    PRINT 'No live EULA uses {{HostName}}; unchanged';
