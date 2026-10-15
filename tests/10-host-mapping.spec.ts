import { test, expect, signedOut } from '../fixtures/test';
import { canUseIdentityDb, queryIdentityDb } from '../fixtures/localDb';
import { HostSignInFlow } from '../pages/HostSignInFlow';
import { escape } from '../pages/IdentityLoginPage';
import { PasswordGrantApi } from '../pages/PasswordGrantApi';
import { env, type OidcClient } from '../config/environment';

const INVALID_CREDENTIALS = { error: 'invalid_grant', error_description: 'invalid_username_or_password' };
const MFA_REQUIRED = { error: 'invalid_grant', error_description: 'mfa_required' };
const SECOND_HOST_ORGANISATION = 99725;

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function driverId(): string {
  return `(SELECT Id FROM Users WHERE Email = ${sqlText(env.driver!.email)})`;
}

function hostOf(client: OidcClient): string {
  return `(SELECT HostID FROM app.HostClients WHERE ClientID = ${sqlText(client.clientId)} AND Active = 1)`;
}

function mappingWhere(client: OidcClient): string {
  return `UserID = ${driverId()} AND HostID = ${hostOf(client)}`;
}

function activeMapping(client: OidcClient): { organisationId: string; role: string } | null {
  const row = queryIdentityDb(
    `SELECT CONCAT(uh.OrganisationID, '|', r.Name) FROM app.UserHosts uh JOIN Roles r ON r.Id = uh.RoleID WHERE uh.${mappingWhere(client)} AND uh.Active = 1`,
  );
  if (row === null) return null;
  const [organisationId, role] = row.split('|');
  return { organisationId, role };
}

test.describe('Host and user mapping (QC-725)', () => {
  test.use(signedOut);
  test.skip(!env.hostClient || !env.secondHostClient, 'Needs two host clients on different Identity hosts (HOST_CLIENT_ID / SECOND_HOST_CLIENT_ID and their redirect URIs).');
  test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD in env/<env>.secrets.env).');
  test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE) to read and change host mappings.");

  test('HOSTMAP-01 a mapped driver gets the organisation and role of the client host in the access token', async ({ page, request }) => {
    const mapping = activeMapping(env.hostClient!);
    expect(mapping, 'the test driver is mapped to the first host').not.toBeNull();

    const flow = new HostSignInFlow(page, env.hostClient!);
    await flow.signIn(env.driver!);
    const claims = await flow.accessTokenClaims(request);

    expect(claims.OrganisationId).toBe(mapping!.organisationId);
    expect(claims.role).toBe(mapping!.role);
    expect(claims.client_id).toBe(env.hostClient!.clientId);
  });

  test('HOSTMAP-02 a driver with no mapping at a host is refused on its sign-in page', async ({ page }) => {
    expect(activeMapping(env.secondHostClient!), 'the test driver is not mapped to the second host').toBeNull();

    const flow = new HostSignInFlow(page, env.secondHostClient!);
    await flow.signIn(env.driver!);

    await flow.expectNoAccess();
  });

  test('HOSTMAP-03 a session from one host is not reused at a host the driver is not mapped to', async ({ page }) => {
    expect(activeMapping(env.secondHostClient!), 'the test driver is not mapped to the second host').toBeNull();

    const first = new HostSignInFlow(page, env.hostClient!);
    await first.signIn(env.driver!);
    await first.expectCallback();

    const secondPage = await page.context().newPage();
    const second = new HostSignInFlow(secondPage, env.secondHostClient!);
    await second.open();

    await expect(secondPage).toHaveURL(/\/Account\/Login/i);
    await expect(secondPage).not.toHaveURL(new RegExp(`^${escape(env.secondHostClient!.redirectUri)}`));
  });

  test('HOSTMAP-04 each host client shows the branding of its own host on the sign-in page', async ({ page }) => {
    for (const client of [env.hostClient!, env.secondHostClient!]) {
      const displayName = queryIdentityDb(
        `SELECT DisplayName FROM app.HostBrandings WHERE HostID = ${hostOf(client)} AND Active = 1`,
      );
      expect(displayName, `${client.clientId} has active branding`).not.toBeNull();

      await new HostSignInFlow(page, client).open();
      await expect(page).toHaveTitle(displayName!);
    }
  });

  test('HOSTMAP-05 the schema has no AspNet names and the unused tables are gone', async () => {
    expect(
      queryIdentityDb(
        `SELECT STRING_AGG(name, ', ') FROM (SELECT name FROM sys.objects WHERE name LIKE '%AspNet%' UNION ALL SELECT name FROM sys.indexes WHERE name LIKE '%AspNet%') AS n`,
      ),
    ).toBeNull();
    expect(
      queryIdentityDb(
        `SELECT STRING_AGG(name, ', ') FROM sys.tables WHERE name IN ('ServerSideSessions', 'DeviceCodes', 'PushedAuthorizationRequests', 'IdentityProviders', 'AspNetUserLogins', 'UserLogins')`,
      ),
    ).toBeNull();
    expect(
      queryIdentityDb(`SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.Users') AND name IN ('OrganisationId', 'IsHostAdmin')`),
    ).toBe('0');
  });

  test.describe('changing the test driver mapping', { tag: '@write' }, () => {
    test('HOSTMAP-06 a driver mapped to two hosts gets each host organisation and role', async ({ page, request }) => {
      expect(activeMapping(env.secondHostClient!), 'the test driver is not mapped to the second host').toBeNull();
      const firstHost = activeMapping(env.hostClient!);
      const secondHostNeedsMfa =
        queryIdentityDb(
          `SELECT COUNT(*) FROM app.HostFeatures WHERE HostID = ${hostOf(env.secondHostClient!)} AND FeatureKey = 'mfa' AND IsEnabled = 1 AND Active = 1`,
        ) !== '0';

      try {
        queryIdentityDb(
          `INSERT INTO app.UserHosts (UserID, HostID, OrganisationID, RoleID) SELECT ${driverId()}, ${hostOf(env.secondHostClient!)}, ${SECOND_HOST_ORGANISATION}, Id FROM Roles WHERE Name = 'HostUser'`,
        );

        const second = new HostSignInFlow(page, env.secondHostClient!);
        await second.signIn(env.driver!);
        await expect(second.error).toHaveCount(0);

        if (secondHostNeedsMfa) {
          await second.expectTwoStepEnrolment();
          test.info().annotations.push({ type: 'note', description: 'The second host has the mfa feature on, so the mapped driver reaches two-step enrolment instead of a token.' });
          return;
        }

        const secondClaims = await second.accessTokenClaims(request);
        expect(secondClaims.OrganisationId).toBe(String(SECOND_HOST_ORGANISATION));
        expect(secondClaims.role).toBe('HostUser');

        const first = new HostSignInFlow(await page.context().newPage(), env.hostClient!);
        await first.open();
        const firstClaims = await first.accessTokenClaims(request);
        expect(firstClaims.OrganisationId).toBe(firstHost!.organisationId);
        expect(firstClaims.role).toBe(firstHost!.role);
      } finally {
        queryIdentityDb(`DELETE FROM app.UserHosts WHERE ${mappingWhere(env.secondHostClient!)}`);
      }
    });

    test('HOSTMAP-07 a host admin must use two-step verification at that host, in the browser and on the password grant', async ({ page, request }) => {
      test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
      const original = queryIdentityDb(`SELECT IsHostAdmin FROM app.UserHosts WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);
      expect(original, 'the test driver is mapped to the first host').not.toBeNull();

      try {
        queryIdentityDb(`UPDATE app.UserHosts SET IsHostAdmin = 1 WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);

        const flow = new HostSignInFlow(page, env.hostClient!);
        await flow.signIn(env.driver!);
        await flow.expectTwoStepEnrolment();

        const grant = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
        expect(grant.status).toBe(400);
        expect(grant.body).toMatchObject(MFA_REQUIRED);
      } finally {
        queryIdentityDb(`UPDATE app.UserHosts SET IsHostAdmin = ${Number(original)} WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);
      }
    });

    test('HOSTMAP-08 the password grant needs the Driver role at the client host', async ({ request }) => {
      test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
      const original = queryIdentityDb(`SELECT RoleID FROM app.UserHosts WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);
      expect(original, 'the test driver is mapped to the first host').not.toBeNull();

      try {
        queryIdentityDb(
          `UPDATE app.UserHosts SET RoleID = (SELECT Id FROM Roles WHERE Name = 'HostUser') WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`,
        );

        const grant = await new PasswordGrantApi(request).passwordGrant(env.driver!.email, env.driver!.password);
        expect(grant.status).toBe(400);
        expect(grant.body).toMatchObject(INVALID_CREDENTIALS);
      } finally {
        queryIdentityDb(`UPDATE app.UserHosts SET RoleID = ${sqlText(original!)} WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);
      }
    });

    test('HOSTMAP-09 removing the mapping stops the mobile refresh token and sign-in at that host', async ({ page, request }) => {
      test.skip(!env.mobileClientId, 'No mobile password-grant client is configured for this environment (MOBILE_CLIENT_ID).');
      const api = new PasswordGrantApi(request);
      const issued = await api.passwordGrant(env.driver!.email, env.driver!.password);
      expect(issued.status, JSON.stringify(issued.body)).toBe(200);
      const mappingId = queryIdentityDb(`SELECT UserHostID FROM app.UserHosts WHERE ${mappingWhere(env.hostClient!)} AND Active = 1`);
      expect(mappingId, 'the test driver is mapped to the first host').not.toBeNull();

      try {
        queryIdentityDb(`UPDATE app.UserHosts SET Active = 0 WHERE UserHostID = ${Number(mappingId)}`);

        const refreshed = await api.refresh(issued.body.refresh_token!);
        expect(refreshed.status).toBe(400);
        expect(refreshed.body.error).toBe('invalid_grant');

        const flow = new HostSignInFlow(page, env.hostClient!);
        await flow.signIn(env.driver!);
        await flow.expectNoAccess();
      } finally {
        queryIdentityDb(`UPDATE app.UserHosts SET Active = 1 WHERE UserHostID = ${Number(mappingId)}`);
      }
    });
  });
});
