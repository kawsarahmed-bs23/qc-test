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
import { INVITE_KEYS_SAVED, PRIVATE_KEY_REFUSED, masterHasInviteKeys, masterInviteKeys, qc913Email, removeTestInviteKeys } from '@api/user-invites.api';

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
    'HIK-02 a private JWK pasted on the page, and a wrong type, curve, point, duplicate kid or a sixth key sent to the API, are refused and change nothing',
    { tag: '@write' },
    async ({ hostSignInSettingsPage, request, targetHost }) => {
      const before = masterInviteKeys(targetHost.uuid);
      const pair = newInviteKeyPair(`e2e-qc913-${RUN}-refused`);
      await hostSignInSettingsPage.open(targetHost.uuid);
      expect(await hostSignInSettingsPage.addInviteKey(pair.privateJwk)).toBe(400);
      await expect(hostSignInSettingsPage.inviteKeyFieldError).toHaveText(PRIVATE_KEY_REFUSED);
      await expect(hostSignInSettingsPage.inviteKey(pair.publicKey.kid)).toHaveCount(0);

      const api = AdminApi.asAdmin(request);
      const current = before.filter((key) => key.active).map((key) => JSON.stringify({ kty: 'EC', crv: 'P-256', kid: key.kid, x: key.x, y: key.y }));
      const good = (n: number) => JSON.stringify(newInviteKeyPair(`e2e-qc913-${RUN}-${n}`).publicKey);
      const refusals: [string, string[], RegExp][] = [
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
});
