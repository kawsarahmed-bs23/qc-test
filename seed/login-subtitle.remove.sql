-- QC-721 backstop: clears the login subtitle on the local host's settings row when it still holds a value
-- tests/app/05-login-subtitle.spec.ts writes, and the API restore at the end of the spec did not put it back.
-- The spec restores through POST api/setting/host-setting first, which also clears the API's 10-minute
-- company-settings cache; a change made here is only seen by the sign-in page once that cache expires
-- or the next host-settings save.
SET NOCOUNT ON;

UPDATE app.HostSettings
SET LoginSubtitle = NULL
WHERE HostSettingID = 1
  AND LoginSubtitle IN (N'Dispatch Management System', N'Padded', N'E2E-QC721 kept after save');
