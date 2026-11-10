import { test, expect, signedOut } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canUseIdentityDb, canUseMasterDb, queryIdentityDb, queryMasterDb, runIdentitySeedScript } from '@utils/localDb';
import {
  newInvitePassword,
  nowInSeconds,
  signInviteLink,
  tamperInviteLink,
  INVITE_RESULT_TYPE,
  type InviteLinkOptions,
  type InviteResult,
} from '@utils/inviteLinks';

const RUN = Date.now();
const EMAIL_LIKE = 'qc914-e2e-%@example.test';
const emailFor = (name: string) => `qc914-e2e-${name}-${RUN}@example.test`;

function sqlText(value: string): string {
  return `N'${value.replace(/'/g, "''")}'`;
}

function userUuidOf(email: string): string | null {
  return queryIdentityDb(`SELECT LOWER(CONVERT(nvarchar(36), UserUUID)) FROM auth.Users WHERE NormalizedEmail = UPPER(${sqlText(email)})`);
}

function removeInviteUsers(): void {
  runIdentitySeedScript('identity-qc914.remove.sql', { EmailLike: EMAIL_LIKE });
}

function hostUuidOf(clientId: string): string | null {
  return queryMasterDb(`SELECT CONVERT(varchar(36), HostUUID) FROM app.Hosts WHERE ClientID = ${sqlText(clientId)}`);
}

test.describe('Host-signed invite links on Identity (QC-914)', { tag: '@write' }, () => {
  test.use(signedOut);
  test.describe.configure({ mode: 'serial' });
  test.skip(
    !env.inviteHostPrivateJwk || !env.inviteWrongPrivateJwk,
    'Needs the test invite signing keys (INVITE_TEST_HOST_PRIVATE_JWK / INVITE_TEST_WRONG_PRIVATE_JWK in env/<env>.secrets.env).',
  );
  test.skip(!env.hostClient, 'Needs the host client (HOST_CLIENT_ID / HOST_REDIRECT_URI) whose return URL the links use.');
  test.skip(
    !canUseIdentityDb() || !canUseMasterDb(),
    "Needs Identity's and HOST_MASTER's local databases to find the host and remove the users the invites create.",
  );

  let issuer = '';
  let returnUrl = '';
  const newPerson = { email: emailFor('new'), password: newInvitePassword(), link: '', sub: '' };
  let accepted: InviteResult | null = null;

  const link = (options: Partial<InviteLinkOptions> & { email: string }) =>
    signInviteLink({ privateJwk: env.inviteHostPrivateJwk!, issuer, returnUrl, ...options });

  test.beforeAll(() => {
    issuer = hostUuidOf(env.hostClient!.clientId) ?? '';
    returnUrl = env.hostClient!.redirectUri;
    expect(issuer, `host ${env.hostClient!.clientId} in HOST_MASTER`).toMatch(/^[0-9A-F-]{36}$/i);
    removeInviteUsers();
  });

  test.afterAll(() => {
    removeInviteUsers();
    expect(Number(queryIdentityDb(`SELECT COUNT(*) FROM auth.Users WHERE Email LIKE ${sqlText(EMAIL_LIKE)}`)), 'no QC-914 invite user is left').toBe(0);
  });

  test('INV-01 a new person sets up an account from a Host link and the Host gets an accepted result whose sub is the new UserUUID', async ({
    identityInvitePage,
  }) => {
    const invite = link({ email: newPerson.email, givenName: 'Nova', familyName: 'Tester', userType: 'driver' });
    newPerson.link = invite.token;
    await identityInvitePage.catchReturn(returnUrl);

    await identityInvitePage.open(invite.token);
    await identityInvitePage.expectSetupFor(newPerson.email, 'Nova', 'Tester');
    await identityInvitePage.saveSettings({ password: newPerson.password, acceptTerms: true });

    const result = await identityInvitePage.resultAt(returnUrl);
    await identityInvitePage.expectSignedByIdentity(result);
    const userUuid = userUuidOf(newPerson.email);
    expect(userUuid, 'the new auth.Users row').not.toBeNull();
    expect(result.header.typ).toBe(INVITE_RESULT_TYPE);
    expect(result.payload).toMatchObject({
      aud: env.hostClient!.clientId,
      invite: invite.jti,
      result: 'accepted',
      email: newPerson.email,
      user_type: 'driver',
      complete_url: `${env.identityUrl}/invite/complete`,
    });
    expect(result.payload.sub?.toLowerCase(), 'sub is the UserUUID of the new user').toBe(userUuid);
    newPerson.sub = userUuid!;
    accepted = result;
  });

  test('INV-02 the complete page shows Setup Complete with the host sign-in and, for a driver, the Driver App link', async ({ identityInvitePage }) => {
    test.skip(!accepted, 'INV-01 did not produce an accepted result.');

    await identityInvitePage.openComplete(accepted!);
    await identityInvitePage.expectSetupComplete(true);

    await identityInvitePage.openComplete(accepted!, 'expired');
    await identityInvitePage.expectFailed();
  });

  test('INV-03 Save Settings without accepting the Terms of Use is refused and creates no account', async ({ identityInvitePage }) => {
    const email = emailFor('terms');
    const invite = link({ email });

    await identityInvitePage.open(invite.token);
    await identityInvitePage.saveSettings({ password: newInvitePassword(), acceptTerms: false });

    await identityInvitePage.expectTermsRequired();
    expect(userUuidOf(email), 'no auth.Users row').toBeNull();
  });

  test('INV-04 an existing login signs in from the link, confirms Accept invite, and the Host gets an accepted result with the same sub', async ({
    identityInvitePage,
    identityLoginPage,
  }) => {
    test.skip(!newPerson.sub, 'INV-01 did not create the account.');
    const invite = link({ email: newPerson.email, userType: 'customer' });
    await identityInvitePage.catchReturn(returnUrl);

    await identityInvitePage.open(invite.token);
    const hostName = await identityInvitePage.hostDisplayName();
    await identityInvitePage.expectExistingLogin(newPerson.email, hostName);
    await identityInvitePage.signInToConnect.click();

    await identityLoginPage.expectVisible();
    await expect(identityLoginPage.email).toHaveValue(newPerson.email);
    await identityLoginPage.signIn({ email: newPerson.email, password: newPerson.password });

    await identityInvitePage.expectAcceptQuestion(newPerson.email, hostName);
    await identityInvitePage.acceptConfirm.click();

    const result = await identityInvitePage.resultAt(returnUrl);
    await identityInvitePage.expectSignedByIdentity(result);
    expect(result.payload).toMatchObject({ invite: invite.jti, result: 'accepted', user_type: 'customer', email: newPerson.email });
    expect(result.payload.sub?.toLowerCase(), 'the same UserUUID as the account INV-01 created').toBe(newPerson.sub);

    await identityInvitePage.openComplete(result);
    await identityInvitePage.expectSetupComplete(false);
  });

  test('INV-05 declining the invite answers the Host with a declined result and no account', async ({ identityInvitePage }) => {
    const email = emailFor('decline');
    const invite = link({ email, userType: 'host', givenName: 'Dee', familyName: 'Clined' });
    await identityInvitePage.catchReturn(returnUrl);

    await identityInvitePage.open(invite.token);
    const hostName = await identityInvitePage.hostDisplayName();
    await identityInvitePage.declineLink.click();
    await identityInvitePage.expectDeclineQuestion(hostName);
    await identityInvitePage.declineConfirm.click();

    const result = await identityInvitePage.resultAt(returnUrl);
    await identityInvitePage.expectSignedByIdentity(result);
    expect(result.payload).toMatchObject({ invite: invite.jti, result: 'declined', email, user_type: 'host', given_name: 'Dee', family_name: 'Clined' });
    expect(result.payload.sub, 'a declined result names no user').toBeUndefined();
    expect(userUuidOf(email), 'no auth.Users row').toBeNull();

    await identityInvitePage.openComplete(result);
    await identityInvitePage.expectDeclined(hostName);

    await identityInvitePage.open(invite.token);
    await identityInvitePage.expectFailed();
  });

  test('INV-06 an expired link shows the expired-or-used message and no form', async ({ identityInvitePage }) => {
    const now = nowInSeconds();
    await identityInvitePage.open(link({ email: emailFor('expired'), issuedAt: now - 25 * 3600, expiresAt: now - 3600 }).token);
    await identityInvitePage.expectFailed();
  });

  test('INV-07 a link whose claims were changed after signing is refused', async ({ identityInvitePage }) => {
    const signed = link({ email: emailFor('signed') }).token;
    await identityInvitePage.open(tamperInviteLink(signed, { email: emailFor('attacker') }));
    await identityInvitePage.expectFailed();
  });

  test('INV-08 a link signed with a key the Host does not own is refused, under its own kid or the Host kid', async ({ identityInvitePage }) => {
    const hostKid = (JSON.parse(env.inviteHostPrivateJwk!) as { kid: string }).kid;

    await identityInvitePage.open(link({ email: emailFor('wrongkey'), privateJwk: env.inviteWrongPrivateJwk! }).token);
    await identityInvitePage.expectFailed();

    await identityInvitePage.open(link({ email: emailFor('wrongkey'), privateJwk: env.inviteWrongPrivateJwk!, kid: hostKid }).token);
    await identityInvitePage.expectFailed();
  });

  test('INV-09 a used link cannot be declined, but its login can sign in, confirm and get the same accepted result again', async ({
    identityInvitePage,
    identityLoginPage,
  }) => {
    test.skip(!newPerson.sub, 'INV-01 did not use its link.');
    const jti = accepted!.payload.invite;
    await identityInvitePage.catchReturn(returnUrl);

    await identityInvitePage.openDecline(newPerson.link);
    await identityInvitePage.expectFailed();

    await identityInvitePage.open(newPerson.link);
    const hostName = await identityInvitePage.hostDisplayName();
    await identityInvitePage.expectExistingLogin(newPerson.email, hostName, { used: true });
    await identityInvitePage.signInToConnect.click();
    await identityLoginPage.expectVisible();
    await identityLoginPage.signIn({ email: newPerson.email, password: newPerson.password });

    await identityInvitePage.expectAcceptQuestion(newPerson.email, hostName, { used: true });
    await identityInvitePage.acceptConfirm.click();

    const result = await identityInvitePage.resultAt(returnUrl);
    await identityInvitePage.expectSignedByIdentity(result);
    expect(result.payload).toMatchObject({ invite: jti, result: 'accepted', user_type: 'driver', email: newPerson.email });
    expect(result.payload.sub?.toLowerCase(), 'the same UserUUID as INV-01').toBe(newPerson.sub);
  });

  test('INV-10 a link whose return_url is not a registered return URL of the Host is refused', async ({ identityInvitePage }) => {
    await identityInvitePage.open(link({ email: emailFor('returnurl'), returnUrl: 'https://evil.example/' }).token);
    await identityInvitePage.expectFailed();
  });

  test('INV-11 a link issued more than 5 minutes in the future or longer than 2000 characters is refused', async ({ identityInvitePage }) => {
    const now = nowInSeconds();
    await identityInvitePage.open(link({ email: emailFor('future'), issuedAt: now + 10 * 60, expiresAt: now + 3600 }).token);
    await identityInvitePage.expectFailed();

    const long = link({ email: emailFor('long'), familyName: 'L'.repeat(1600) }).token;
    expect(long.length, 'the signed link is over 2000 characters').toBeGreaterThan(2000);
    await identityInvitePage.open(long);
    await identityInvitePage.expectFailed();
  });
});
