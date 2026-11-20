-- QC-1008: removes the sign-in email history the cases of tests/app/user-signin-emails.spec.ts leave in the Identity database:
-- every auth.AccountEmailRefusals, auth.PasswordResetLinks and auth.MagicLinkTokens row of an e2e.qc913.*@example.com login.
-- Run it before identity-qc913.remove.sql: the refusal table has no foreign key to the login, so its rows would outlive it.
-- Prints REMOVED refusals=<n>;left=<n>.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @Users TABLE (Id nvarchar(450) PRIMARY KEY);
INSERT @Users SELECT Id FROM auth.Users WHERE NormalizedEmail LIKE N'E2E.QC913.%@EXAMPLE.COM';

DECLARE @Removed int = 0;

IF OBJECT_ID(N'auth.AccountEmailRefusals', N'U') IS NOT NULL
BEGIN
    BEGIN TRANSACTION;

    DELETE auth.AccountEmailRefusals WHERE UserId IN (SELECT Id FROM @Users);
    SET @Removed = @@ROWCOUNT;
    DELETE auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users);
    DELETE auth.MagicLinkTokens WHERE UserId IN (SELECT Id FROM @Users);

    COMMIT TRANSACTION;
END;

DECLARE @Left int = 0;
IF OBJECT_ID(N'auth.AccountEmailRefusals', N'U') IS NOT NULL
    SET @Left = (SELECT COUNT(*) FROM auth.AccountEmailRefusals WHERE UserId IN (SELECT Id FROM @Users))
        + (SELECT COUNT(*) FROM auth.PasswordResetLinks WHERE UserId IN (SELECT Id FROM @Users))
        + (SELECT COUNT(*) FROM auth.MagicLinkTokens WHERE UserId IN (SELECT Id FROM @Users));
PRINT CONCAT('REMOVED refusals=', @Removed, ';left=', @Left);
