-- QC-745: one throwaway sensitive template key, E2EQC745:ProbeSecret (host-specific, not required, no value), so TPL can try to
-- make a sensitive key shared without touching a real template key. Run against MASTER_SQL_DATABASE.
-- Every other throwaway key (group E2EQC745) is added by the cases through the Admin API.
-- master-qc745.remove.sql deletes it with everything else the run adds.
SET NOCOUNT ON;
SET XACT_ABORT ON;

DELETE app.SettingTemplates WHERE GroupName = N'E2EQC745' AND PropertyName = N'ProbeSecret';

INSERT app.SettingTemplates (SettingTemplateUUID, GroupName, SubGroupName, PropertyName, PropertyValue, PropertyType, IsSensitive, IsRestartRequired,
    IsHostSpecific, IsRequired, Description, Created, Updated, Active, CreatedBy, UpdatedBy)
VALUES (NEWID(), N'E2EQC745', NULL, N'ProbeSecret', NULL, N'string', 1, 0, 1, 0, N'E2E QC-745 probe', SYSUTCDATETIME(), SYSUTCDATETIME(), 1, N'e2e', N'e2e');
