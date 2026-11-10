import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { canUseIdentityDb, queryIdentityDb } from '@utils/localDb';
import { decodeJwt } from '@api/password-grant.api';
import { IdentityAdminApi } from '@api/identity-admin.api';
import { HostSignInFlow } from '@pages/host-sign-in-flow.page';
import { canSeedThrowawayUsers, countQc897Leftovers, removeQc897Users, seedQc897User, type UuidUser } from '@utils/throwawayUsers';
import { env } from '@config/env.config';

const IDENTITY_TABLES = [
  'Users',
  'Roles',
  'UserRoles',
  'UserClaims',
  'RoleClaims',
  'UserTokens',
  'UserPasskeys',
  'MagicLinkTokens',
  'PasswordResetCodes',
  'PasswordResetLinks',
  'DataProtectionKeys',
  'PersistedGrants',
  'Keys',
  'Clients',
  'ClientScopes',
  'ClientGrantTypes',
  'ClientRedirectUris',
  'ClientSecrets',
  'ApiResources',
  'ApiScopes',
  'IdentityResources',
];

const THROWAWAY_EMAIL = 'e2e.qc897.subject@quarryconnect.test';

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function lines(value: string | null): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function userUuidOf(email: string): string | null {
  return queryIdentityDb(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`);
}

function userIdOf(email: string): string | null {
  return queryIdentityDb(`SELECT Id FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`);
}

function grantsFor(subject: string): number {
  return Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.PersistedGrants WHERE SubjectId = ${sqlText(subject)}`));
}

function lastSessionId(): number {
  return Number(queryIdentityDb('SELECT ISNULL(MAX(UserSessionID), 0) FROM app.UserSessions'));
}

function sessionSubjectsSince(mark: number, subjects: string[]): string[] {
  const list = subjects.map(sqlText).join(', ');
  return lines(queryIdentityDb(`SELECT LOWER(SubjectID) FROM app.UserSessions WHERE UserSessionID > ${mark} AND SubjectID IN (${list})`));
}

test.describe('Identity tables in the auth schema and UserUUID as the token subject (QC-897)', { tag: ['@regression', '@auth'] }, () => {
  test.use(signedOut);
  test.skip(!canUseIdentityDb(), "Needs Identity's local database (LOCAL_SQL_SERVER / IDENTITY_SQL_DATABASE).");

  test('UUID-01 every Identity table is in the auth schema, dbo keeps only the migrations history and app.UserSessions stays in app', async () => {
    const tables = lines(queryIdentityDb(`SELECT s.name + '.' + t.name FROM sys.tables t JOIN sys.schemas s ON s.schema_id = t.schema_id ORDER BY 1`));

    expect(tables.filter((name) => name.startsWith('dbo.'))).toEqual(['dbo.__EFMigrationsHistory']);
    expect(tables).toContain('app.UserSessions');
    for (const table of IDENTITY_TABLES) {
      expect(tables, `auth.${table}`).toContain(`auth.${table}`);
    }
    expect(tables.filter((name) => !name.startsWith('auth.') && !name.startsWith('app.') && !name.startsWith('dbo.'))).toEqual([]);
    expect(tables.filter((name) => name.startsWith('app.'))).toEqual(['app.UserSessions']);
  });

  test('UUID-02 every user has a distinct UserUUID, enforced by a unique not-null column, and existing users kept UserUUID = Id', async () => {
    const column = queryIdentityDb(
      `SELECT CONCAT(TYPE_NAME(c.system_type_id), '|', c.is_nullable) FROM sys.columns c WHERE c.object_id = OBJECT_ID('auth.Users') AND c.name = 'UserUUID'`,
    );
    expect(column).toBe('uniqueidentifier|0');
    expect(
      queryIdentityDb(
        `SELECT CONCAT(CAST(i.is_unique AS int), '|', COL_NAME(ic.object_id, ic.column_id)) FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.object_id = OBJECT_ID('auth.Users') AND i.name = 'UX_Users_UserUUID'`,
      ),
    ).toBe('1|UserUUID');

    const [total, distinct, missing] = queryIdentityDb(
      `SELECT CONCAT(COUNT(*), '|', COUNT(DISTINCT UserUUID), '|', SUM(CASE WHEN UserUUID IS NULL THEN 1 ELSE 0 END)) FROM auth.Users`,
    )!
      .split('|')
      .map(Number);
    expect(total).toBeGreaterThan(0);
    expect(distinct).toBe(total);
    expect(missing).toBe(0);

    for (const account of [env.admin, env.driver]) {
      if (!account) continue;
      const id = userIdOf(account.email);
      expect(id, `${account.email} exists`).not.toBeNull();
      expect(userUuidOf(account.email), `${account.email} UserUUID = Id`).toBe(id!.toLowerCase());
    }
  });

  test.describe('the seeded driver', () => {
    test.skip(!env.driver, 'Needs the seeded test driver (DRIVER_EMAIL / DRIVER_PASSWORD).');

    test("UUID-03 a mobile password-grant token's sub is the user's UserUUID, the stored grant uses it and a refresh keeps it", async ({
      passwordGrantApi,
    }) => {
      test.skip(!env.mobileClientId, 'Needs the mobile password-grant client (MOBILE_CLIENT_ID).');
      const userUuid = userUuidOf(env.driver!.email)!;

      const issued = await passwordGrantApi.passwordGrant(env.driver!.email, env.driver!.password);
      expect(issued.status, `${issued.body.error ?? ''} ${issued.body.error_description ?? ''}`).toBe(200);
      const sub = String(decodeJwt(issued.body.access_token!).claims.sub);
      expect(sub.toLowerCase()).toBe(userUuid);
      expect(grantsFor(sub)).toBeGreaterThan(0);

      const refreshed = await passwordGrantApi.refresh(issued.body.refresh_token!);
      expect(refreshed.status, `${refreshed.body.error ?? ''} ${refreshed.body.error_description ?? ''}`).toBe(200);
      expect(String(decodeJwt(refreshed.body.access_token!).claims.sub).toLowerCase()).toBe(userUuid);

      expect(await passwordGrantApi.revoke(refreshed.body.refresh_token!)).toBe(200);
    });

    test("UUID-04 an interactive host sign-in returns to the host app with sub = UserUUID, and Identity's session row has SubjectID = UserUUID", async ({
      page,
      request,
    }) => {
      test.skip(!env.hostClient, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI).');
      const userUuid = userUuidOf(env.driver!.email)!;
      const mark = lastSessionId();

      const flow = new HostSignInFlow(page, env.hostClient!);
      await flow.signIn(env.driver!);
      const tokens = await flow.tokens(request);

      expect(String(tokens.access.sub).toLowerCase()).toBe(userUuid);
      expect(String(tokens.id.sub).toLowerCase()).toBe(userUuid);
      expect(sessionSubjectsSince(mark, [userUuid])).toContain(userUuid);
    });
  });

  test.describe('a user whose UserUUID differs from its Id', { tag: '@write' }, () => {
    test.describe.configure({ mode: 'serial' });
    test.skip(!canSeedThrowawayUsers(), "Needs Identity's local database and ADMIN_EMAIL / ADMIN_PASSWORD for the throwaway user.");
    test.skip(!env.mobileClientId, 'Needs the mobile password-grant client (MOBILE_CLIENT_ID).');
    test.skip(!env.adminApiClient, "Needs Identity's administration service client (ADMIN_API_CLIENT_ID / ADMIN_API_CLIENT_SECRET) to deactivate the user.");

    let user: UuidUser;

    test.beforeAll(() => {
      removeQc897Users();
      user = seedQc897User(THROWAWAY_EMAIL, 'QC-897 Subject');
    });

    test.afterAll(() => {
      removeQc897Users();
      expect(countQc897Leftovers(), 'no QC-897 user, grant or session is left').toBe(0);
    });

    test('UUID-05 tokens, refresh, userinfo, the host session and deactivation all key on UserUUID, not Id', async ({ page, request, passwordGrantApi }) => {
      expect(user.userUuid).not.toBe(user.userId.toLowerCase());

      const issued = await passwordGrantApi.passwordGrant(user.email, user.password);
      expect(issued.status, `${issued.body.error ?? ''} ${issued.body.error_description ?? ''}`).toBe(200);
      const sub = String(decodeJwt(issued.body.access_token!).claims.sub);
      expect(sub.toLowerCase()).toBe(user.userUuid);
      expect(sub.toLowerCase()).not.toBe(user.userId.toLowerCase());
      expect(grantsFor(sub)).toBeGreaterThan(0);
      expect(grantsFor(user.userId)).toBe(0);

      const refreshed = await passwordGrantApi.refresh(issued.body.refresh_token!);
      expect(refreshed.status, `${refreshed.body.error ?? ''} ${refreshed.body.error_description ?? ''}`).toBe(200);
      expect(String(decodeJwt(refreshed.body.access_token!).claims.sub).toLowerCase()).toBe(user.userUuid);

      const info = await passwordGrantApi.userInfo(refreshed.body.access_token!);
      expect(info.status).toBe(200);
      expect(String(info.body?.sub).toLowerCase()).toBe(user.userUuid);

      if (env.hostClient) {
        const mark = lastSessionId();
        const flow = new HostSignInFlow(page, env.hostClient);
        await flow.signIn(user);
        const tokens = await flow.tokens(request);
        expect(String(tokens.access.sub).toLowerCase()).toBe(user.userUuid);
        expect(sessionSubjectsSince(mark, [user.userUuid, user.userId])).toEqual(expect.arrayContaining([user.userUuid]));
        expect(sessionSubjectsSince(mark, [user.userId])).toEqual([]);
      }

      const admin = await IdentityAdminApi.signIn(request);
      const deactivated = await admin.post(`/users/${user.userId}/deactivate`);
      expect(deactivated.status, deactivated.text).toBe(200);
      expect(deactivated.body.isActive).toBe(false);
      expect(grantsFor(sub)).toBe(0);

      const afterDeactivation = await passwordGrantApi.refresh(refreshed.body.refresh_token!);
      expect(afterDeactivation.status).toBe(400);
      expect(afterDeactivation.body.error).toBe('invalid_grant');
    });
  });
});
