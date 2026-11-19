// QC-915: Admin keeps each host's invite signing public keys in HOST_MASTER app.HostInviteSigningKeys (Sign-in page card
// #invite-keys-card, GET/PUT api/hosts/{hostUuid}/invite-keys), and Identity reads them through the hosts feed to check the
// links the host signs. Local only. Needs an Admin API and HOST_MASTER with the QC-915 migration (202611111300) and an Identity
// that reads invite keys from HOST_MASTER. The host's own keys (for example qc913-local-1) are only read; HIK-03 adds and
// removes a key of its own (kid e2e-qc913-<run>, a fresh P-256 pair) and seed/master-qc913-invite-keys.remove.sql deletes every
// e2e-qc913-* / qc914-local-* row afterwards, whatever state a failure left it in.
import { test, expect } from '@fixtures/pageFixtures';
import { env } from '@config/env.config';
import { canUseMasterDb } from '@utils/localDb';
import { AdminApi, canUseAdminApi } from '@api/admin.api';
import { newInviteKeyPair, signInviteLink } from '@utils/inviteLinks';
import { MailSink } from '@pages/host-password-link.page';
import { DflowHostAdminApi } from '@api/driver-flows.api';
import {
  HOST_KEY_ALREADY_REGISTERED,
  activeInviteKeyCount,
  createOrganisationUser,
  hostOrganisationId,
  hostInviteKid,
  hostKeyStatus,
  hostServiceToken,
  readinessKey,
  registerHostKey,
} from '@api/invite-readiness.api';
import {
  HostUserInvitesApi,
  Qc913Data,
  identityAcceptsLink,
  inviteEmailTo,
  removeQc913Data,
  INVITE_KEYS_SAVED,
  NOT_SENT_MESSAGE,
  PRIVATE_KEY_PAGE_MESSAGE,
  PRIVATE_KEY_REFUSED,
  masterHasInviteKeys,
  masterInviteKeys,
  qc913Email,
  removeTestInviteKeys,
} from '@api/user-invites.api';

const RUN = Date.now().toString(36);

function cacheWindow(): number {
  return env.identityHostCacheSeconds * 1000;
}

test.describe('Host invite signing keys in HOST_MASTER (QC-915)', { tag: ['@regression'] }, () => {
  test.skip(env.name !== 'local' || !canUseMasterDb() || !canUseAdminApi(), 'Needs HOST_MASTER (MASTER_SQL_DATABASE) and ADMIN_API_URL (local only).');
  test.skip(canUseMasterDb() && !masterHasInviteKeys(), 'HOST_MASTER has no app.HostInviteSigningKeys (QC-915 migration 202611111300).');

  test.afterAll(() => {
    expect(removeTestInviteKeys()).toMatch(/left=0/);
  });

  test('HIK-01 the Sign-in page lists the host keys from HOST_MASTER with their kid and type, and the API answers them only to an admin', async ({
    hostSignInSettingsPage,
    request,
    targetHost,
  }) => {
    const active = masterInviteKeys(targetHost.uuid).filter((key) => key.active);
    await hostSignInSettingsPage.open(targetHost.uuid);
    await expect(hostSignInSettingsPage.inviteKeysCard).toBeVisible();
    await expect(hostSignInSettingsPage.inviteKeysHint).toContainText('paste only the public key');
    await expect(hostSignInSettingsPage.inviteKeysList.locator('[data-kid]')).toHaveCount(active.length);
    for (const key of active) {
      await expect(hostSignInSettingsPage.inviteKey(key.kid)).toContainText(key.kid);
      await expect(hostSignInSettingsPage.inviteKey(key.kid)).toContainText(/EC P-256, added \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
      await expect(hostSignInSettingsPage.inviteKeyRemove(key.kid)).toBeEnabled();
    }
    if (active.length === 0) await expect(hostSignInSettingsPage.inviteKeysEmpty).toBeVisible();

    const listed = await AdminApi.asAdmin(request).get<{ kid: string; kty: string; crv: string; x: string; y: string; added: string }[]>(
      `/hosts/${targetHost.uuid}/invite-keys`,
    );
    expect(listed.status, listed.text).toBe(200);
    expect(listed.body.map((key) => ({ kid: key.kid, x: key.x, y: key.y }))).toEqual(active.map((key) => ({ kid: key.kid, x: key.x, y: key.y })));
    expect(listed.text, 'no private part is ever answered').not.toMatch(/"d"\s*:/);
    expect((await new AdminApi(request, null).get(`/hosts/${targetHost.uuid}/invite-keys`)).status).toBe(401);
  });

  test(
    'HIK-02 a private JWK, a wrong type, curve, point, duplicate kid or a sixth key sent to the API are refused and change nothing',
    { tag: '@write' },
    async ({ request, targetHost }) => {
      const before = masterInviteKeys(targetHost.uuid);
      const pair = newInviteKeyPair(`e2e-qc913-${RUN}-refused`);
      const api = AdminApi.asAdmin(request);
      const current = before.filter((key) => key.active).map((key) => JSON.stringify({ kty: 'EC', crv: 'P-256', kid: key.kid, x: key.x, y: key.y }));
      const good = (n: number) => JSON.stringify(newInviteKeyPair(`e2e-qc913-${RUN}-${n}`).publicKey);
      const refusals: [string, string[], RegExp | string][] = [
        ['a private key', [pair.privateJwk], PRIVATE_KEY_REFUSED],
        ['an RSA key', [JSON.stringify({ ...pair.publicKey, kty: 'RSA' })], /kty\) must be EC/],
        ['a P-384 key', [JSON.stringify({ ...pair.publicKey, crv: 'P-384' })], /crv\) must be P-256/],
        ['a point off the curve', [JSON.stringify({ ...pair.publicKey, y: pair.publicKey.x })], /not a point on the P-256 curve/],
        ['a short x', [JSON.stringify({ ...pair.publicKey, x: 'AAAA' })], /base64url P-256 coordinate/],
        ['two keys with one kid', [good(1), JSON.stringify({ ...JSON.parse(good(2)), kid: `e2e-qc913-${RUN}-1` })], /Two keys have the kid/],
        ['six keys', [1, 2, 3, 4, 5, 6].map(good), /at most 5 keys/],
        ['not JSON', ['{kty:EC'], /not a JWK/],
      ];
      for (const [name, keys, error] of refusals) {
        const answer = await api.put(`/hosts/${targetHost.uuid}/invite-keys`, { keys: [...current.slice(0, Math.max(0, 5 - keys.length)), ...keys] });
        expect.soft(answer.status, `${name}: ${answer.text}`).toBe(400);
        expect.soft(answer.text, name).toMatch(error);
      }
      expect(masterInviteKeys(targetHost.uuid), 'HOST_MASTER is unchanged').toEqual(before);
    },
  );

  test('HIK-04 a private JWK pasted on the page is refused in the browser: the field shows why, nothing is sent to the Admin API, and the box is cleared', async ({
    hostSignInSettingsPage,
    targetHost,
  }) => {
    const before = masterInviteKeys(targetHost.uuid);
    const pair = newInviteKeyPair(`e2e-qc913-${RUN}-private`);
    await hostSignInSettingsPage.open(targetHost.uuid);
    expect(await hostSignInSettingsPage.addInviteKeyRefusedOnPage(pair.privateJwk), 'no PUT .../invite-keys is sent').toBe(0);
    await expect(hostSignInSettingsPage.inviteKeyFieldError).toHaveText(PRIVATE_KEY_PAGE_MESSAGE);
    await expect(hostSignInSettingsPage.inviteKeyInput, 'the private key is not left on the page').toHaveValue('');
    await expect(hostSignInSettingsPage.inviteKey(pair.publicKey.kid)).toHaveCount(0);
    expect(masterInviteKeys(targetHost.uuid), 'HOST_MASTER is unchanged').toEqual(before);
  });

  test(
    'HIK-03 a public key added on the page is listed, stored, served to Identity (which then takes links signed with it), and Remove retires it; the host keys stay as they were',
    { tag: '@write' },
    async ({ hostSignInSettingsPage, identityInvitePage, shell, targetHost }) => {
      test.skip(!env.hostClient, 'Needs HOST_REDIRECT_URI, a registered return URL of the host, for the probe link.');
      test.setTimeout(cacheWindow() + 180_000);
      const before = masterInviteKeys(targetHost.uuid);
      const pair = newInviteKeyPair(`e2e-qc913-${RUN}`);
      const probe = () =>
        signInviteLink({
          privateJwk: pair.privateJwk,
          issuer: targetHost.uuid.toUpperCase(),
          email: qc913Email('key-probe'),
          returnUrl: env.hostClient!.redirectUri,
          userType: 'host',
        }).token;

      try {
        expect(await identityInvitePage.acceptsLink(probe()), 'Identity refuses a link signed with a key it does not have').toBe(false);

        await hostSignInSettingsPage.open(targetHost.uuid);
        expect(await hostSignInSettingsPage.addInviteKey(JSON.stringify(pair.publicKey))).toBe(200);
        await shell.expectStatus(INVITE_KEYS_SAVED);
        await expect(hostSignInSettingsPage.inviteKey(pair.publicKey.kid)).toContainText(/EC P-256, added/);
        await expect(hostSignInSettingsPage.inviteKeyInput).toHaveValue('');
        expect(masterInviteKeys(targetHost.uuid)).toEqual([...before, { kid: pair.publicKey.kid, active: true, x: pair.publicKey.x, y: pair.publicKey.y }]);

        await expect
          .poll(() => identityInvitePage.acceptsLink(probe()), {
            message: 'Identity reads the new key from the hosts feed within its cache window',
            timeout: cacheWindow(),
            intervals: [5_000, 10_000, 15_000],
          })
          .toBe(true);

        await hostSignInSettingsPage.open(targetHost.uuid);
        expect(await hostSignInSettingsPage.removeInviteKey(pair.publicKey.kid)).toBe(200);
        await expect(hostSignInSettingsPage.inviteKey(pair.publicKey.kid)).toHaveCount(0);
        expect(masterInviteKeys(targetHost.uuid)).toEqual([...before, { kid: pair.publicKey.kid, active: false, x: pair.publicKey.x, y: pair.publicKey.y }]);
        for (const key of before.filter((k) => k.active)) await expect(hostSignInSettingsPage.inviteKey(key.kid)).toBeVisible();
      } finally {
        removeTestInviteKeys();
        expect(masterInviteKeys(targetHost.uuid), 'the host keys are as they were').toEqual(before);
      }
    },
  );

  test('HIK-05 a host that signs with a key HOST_MASTER does not hold is reported NOT registered by the API and on the card, with a Register button', async ({
    hostSignInSettingsPage,
    request,
    targetHost,
  }) => {
    test.skip(!env.appApiUrl || !env.adminApiClient, 'Needs APP_API_URL and the Admin service client (ADMIN_API_CLIENT_ID/SECRET).');
    removeTestInviteKeys();
    const kid = await hostInviteKid(request);
    test.skip(!kid, 'The host API has no invite signing key.');
    const status = await hostKeyStatus(request, targetHost.uuid);
    test.skip(status.state !== 'not-registered', `The host's key ${kid} is a permanent registered key (state ${status.state}); start the host API with a throwaway Invites:SigningKey.`);
    expect(status).toEqual({ state: 'not-registered', kid });

    await hostSignInSettingsPage.open(targetHost.uuid);
    await expect(hostSignInSettingsPage.inviteKeyHostStatus).toHaveAttribute('data-state', 'not-registered');
    await expect(hostSignInSettingsPage.inviteKeyHostStatus).toContainText(`Host signs with ${kid}`);
    await expect(hostSignInSettingsPage.inviteKeyHostStatus).toContainText('NOT registered');
    await expect(hostSignInSettingsPage.inviteKeyRegister).toBeVisible();
    await expect(hostSignInSettingsPage.inviteKey(kid!)).toHaveCount(0);
  });

  test(
    'HIK-06 Register adds the host key to HOST_MASTER once (a second call changes nothing), the card turns Registered, and Identity then takes a real invite the host sent',
    { tag: '@write' },
    async ({ hostSignInSettingsPage, request, targetHost }) => {
      test.skip(!env.appApiUrl || !env.adminApiClient || !env.appAdmin, 'Needs APP_API_URL, the Admin service client and APP_ADMIN_EMAIL / APP_ADMIN_PASSWORD.');
      test.skip(!(await MailSink.isListening()), `The SMTP sink is not listening on 127.0.0.1:${env.smtpSinkPort}.`);
      test.skip(!Qc913Data.sinkIsConfigured(), 'EmailSettings MailServer/MailPort do not point at the SMTP sink.');
      test.setTimeout(cacheWindow() + 240_000);
      const kid = await hostInviteKid(request);
      test.skip(!kid, 'The host API has no invite signing key.');
      test.skip(!kid!.startsWith('e2e-qc913-'), `The host's key ${kid} is a permanent key, so this case does not register or remove it.`);
      removeTestInviteKeys();
      const before = masterInviteKeys(targetHost.uuid);
      const email = qc913Email('hik-register');

      try {
        const admin = new DflowHostAdminApi(request);
        expect(await admin.signIn(env.appAdmin!.email, env.appAdmin!.password), 'the host admin signs in').toBe(200);
        const invites = new HostUserInvitesApi(request).withToken(admin.bearer());
        removeQc913Data();
        const created = await createOrganisationUser(request, admin.bearer(), email, hostOrganisationId());
        expect(created.status, created.text).toBe(201);
        const since = MailSink.mark();
        const sent = await invites.sendInvite('manageusers', created.id!);
        const mailBlocked = sent.status === 400 && sent.text.includes(NOT_SENT_MESSAGE);
        if (!mailBlocked) expect(sent.status, sent.text).toBe(200);
        const token = mailBlocked ? null : new URL((await inviteEmailTo(email, since)).acceptUrl).searchParams.get('t')!;

        await hostSignInSettingsPage.open(targetHost.uuid);
        await expect(hostSignInSettingsPage.inviteKeyHostStatus).toHaveAttribute('data-state', 'not-registered');
        expect(await hostSignInSettingsPage.registerHostInviteKey()).toBe(200);
        await expect(hostSignInSettingsPage.inviteKeyHostStatus).toHaveAttribute('data-state', 'registered');
        await expect(hostSignInSettingsPage.inviteKeyHostStatus).toContainText('Registered');
        await expect(hostSignInSettingsPage.inviteKeyRegister).toHaveCount(0);
        await expect(hostSignInSettingsPage.inviteKey(kid!)).toContainText(/EC P-256, added/);
        expect(activeInviteKeyCount(targetHost.uuid, kid!)).toBe(1);
        expect(masterInviteKeys(targetHost.uuid).filter((k) => k.kid !== kid)).toEqual(before);

        const again = await registerHostKey(request, targetHost.uuid);
        expect(again.status, again.text).toBe(200);
        expect(again.text).toContain(HOST_KEY_ALREADY_REGISTERED);
        expect(activeInviteKeyCount(targetHost.uuid, kid!)).toBe(1);
        expect(masterInviteKeys(targetHost.uuid)).toHaveLength(before.length + 1);
        expect(await hostKeyStatus(request, targetHost.uuid)).toEqual({ state: 'registered', kid });

        if (token === null) {
          test.info().annotations.push({
            type: 'skipped check',
            description: 'The host API could not send the invite email (its SMTP client was built with credentials and needs TLS, the sink has none), so Identity was not asked to take a real invite.',
          });
        } else {
          await expect
            .poll(() => identityAcceptsLink(request, token), {
              message: 'Identity reads the registered key within its cache window and takes the host invite',
              timeout: cacheWindow(),
              intervals: [5_000, 10_000, 15_000],
            })
            .toBe(true);
        }
      } finally {
        removeQc913Data();
        removeTestInviteKeys();
        const after = masterInviteKeys(targetHost.uuid);
        expect(after, 'the permanent host keys are as they were').toEqual(before);
        for (const key of after.filter((k) => k.active)) expect(key.kid.startsWith('e2e-qc913-')).toBe(false);
      }
    },
  );

  test(
    'HIK-07 a host with no invite key shows "Invites not set up" with no Register button, and Register is refused with 400 on the keys field',
    { tag: '@write' },
    async ({ hostSignInSettingsPage, request, targetHost }) => {
      const status = await hostKeyStatus(request, targetHost.uuid);
      test.skip(status.state !== 'not-set-up', `The host API has an invite key (state ${status.state}); this case needs a host API started without Invites:SigningKey.`);
      const before = masterInviteKeys(targetHost.uuid);
      expect(status.kid).toBeNull();

      await hostSignInSettingsPage.open(targetHost.uuid);
      await expect(hostSignInSettingsPage.inviteKeyHostStatus).toHaveAttribute('data-state', 'not-set-up');
      await expect(hostSignInSettingsPage.inviteKeyHostStatus).toContainText('Invites not set up');
      await expect(hostSignInSettingsPage.inviteKeyRegister).toHaveCount(0);

      const refused = await registerHostKey(request, targetHost.uuid);
      expect(refused.status, refused.text).toBe(400);
      expect(refused.text).toMatch(/"keys"/i);
      expect(masterInviteKeys(targetHost.uuid), 'HOST_MASTER is unchanged').toEqual(before);
    },
  );

  test('HIK-08 GET api/invite-readiness/key on the host answers the public key to the Admin service token only: kid, kty, crv, x and y with no d; 401 with no token, 401 or 403 for a driver token', async ({
    passwordGrantApi,
    request,
    targetHost,
  }) => {
    test.skip(!env.appApiUrl || !env.adminApiClient, 'Needs APP_API_URL and the Admin service client (ADMIN_API_CLIENT_ID/SECRET).');
    const served = await readinessKey(request, await hostServiceToken(request));
    expect(served.status, served.text).toBe(200);
    expect(served.key).toMatchObject({ kty: 'EC', crv: 'P-256' });
    expect(served.key!.kid).toBeTruthy();
    expect(served.key!.x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(served.key!.y).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(served.text, 'no private part is ever answered').not.toMatch(/"d"\s*:/);
    expect((await hostKeyStatus(request, targetHost.uuid)).kid).toBe(served.key!.kid);

    expect((await readinessKey(request, null)).status).toBe(401);

    if (env.driver) {
      const driver = await passwordGrantApi.passwordGrant(env.driver.email, env.driver.password);
      expect(driver.status, 'the driver signs in').toBe(200);
      expect([401, 403]).toContain((await readinessKey(request, driver.body.access_token!)).status);
    } else {
      test.info().annotations.push({ type: 'skipped check', description: 'DRIVER_EMAIL / DRIVER_PASSWORD are not set, so the driver token was not tried.' });
    }
  });
});
